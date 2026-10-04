import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { sha256Buffer } from '../crypto.js';
import { formatStamp } from '../certificate.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

/**
 * Verification lives in two places that work identically:
 *
 *   public  — /, /verify/:id  — for anyone holding a sealed PDF. The /verify/:id
 *             address is printed on every certificate and encoded in QR fields,
 *             and the people following it (signers, a bank, a client) have no
 *             account, so it must never require one.
 *   in-app  — /verification, /verification/:id — the same checks for signed-in
 *             people, inside the app with its sidebar like every other page.
 *
 * The handlers below are written once and mounted on both; only the frame and
 * the form addresses differ.
 */
const MODES = {
  public: { inApp: false, lookupAction: '/', uploadAction: '/check', base: '/verify' },
  app: { inApp: true, lookupAction: '/verification', uploadAction: '/verification/upload', base: '/verification' },
};

function show(res, mode, data, status = 200) {
  res.status(status).render('verify', { result: null, lookup: null, query: '', formatStamp, ...MODES[mode], ...data });
}

/** Keeps multer's rejections on the verify page rather than the 500 handler. */
const receivePdf = (mode) => (req, res, next) => {
  upload.single('pdf')(req, res, (err) => {
    if (!err) return next();
    show(res, mode, {
      result: {
        error:
          err.code === 'LIMIT_FILE_SIZE'
            ? `That file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
            : err.message || 'That upload could not be read.',
      },
    }, 400);
  });
};

/**
 * Deliberately shows only what a holder of the document already knows — title,
 * hashes, who signed and when — and never the file itself, so a leaked
 * document ID does not leak the contents.
 */
function publicView(doc) {
  const recipients = db
    .prepare('SELECT name, email, status, viewed_at, signed_at, last_ip FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(doc.id);
  const events = db
    .prepare('SELECT actor, action, detail, ip, created_at FROM audit_events WHERE document_id = ? ORDER BY id')
    .all(doc.id);
  // The organisation shown is the company the document was sent from.
  const owner = db
    .prepare('SELECT u.display_name, u.email, c.name AS org_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?')
    .get(doc.owner_id);
  return { doc, recipients, events, owner };
}

/* ------------------------------------------------------------- handlers */

const blank = (mode) => (req, res) => show(res, mode, {});

// Templates are never signed, so they are never something to verify — and a
// private one must not be discoverable here by its id.
const byId = (mode) => (req, res) => {
  const doc = db.prepare(`SELECT * FROM documents WHERE id = ? AND status != 'template'`).get(req.params.id);
  if (!doc) return show(res, mode, { lookup: { found: false, id: req.params.id }, query: req.params.id }, 404);
  show(res, mode, { lookup: { found: true, ...publicView(doc) }, query: doc.id });
};

/** Look up by document ID or by pasting either hash. */
const lookup = (mode) => (req, res) => {
  const q = String(req.body.query || '').trim();
  const doc = db
    .prepare(`SELECT * FROM documents WHERE status != 'template' AND (id = ? OR sealed_sha256 = ? OR signed_sha256 = ? OR original_sha256 = ?)`)
    .get(q, q.toLowerCase(), q.toLowerCase(), q.toLowerCase());
  if (!doc) return show(res, mode, { lookup: { found: false, id: q }, query: q }, 404);
  show(res, mode, { lookup: { found: true, ...publicView(doc) }, query: q });
};

/**
 * Hashes an uploaded file and reports which of the recorded hashes it matches.
 * This is the check that actually proves tampering: a byte changed anywhere in
 * the PDF produces a different digest and matches nothing.
 */
const check = (mode) => (req, res) => {
  if (!req.file) return show(res, mode, { result: { error: 'Choose a PDF to check.' } }, 400);
  const sha = sha256Buffer(req.file.buffer);
  const doc = db
    .prepare(`SELECT * FROM documents WHERE status != 'template' AND (sealed_sha256 = ? OR signed_sha256 = ? OR original_sha256 = ?)`)
    .get(sha, sha, sha);

  if (!doc) {
    return show(res, mode, {
      result: {
        sha, match: 'none', filename: req.file.originalname,
        message:
          'This file does not match any document we hold. Either it was not sealed here, or it has been altered since it was — even a single changed byte produces a different hash.',
      },
    });
  }

  const match =
    sha === doc.sealed_sha256 ? 'sealed' : sha === doc.signed_sha256 ? 'signed' : 'original';
  const message = {
    sealed: 'This is the sealed document exactly as it was issued, certificate of completion included. It has not been altered.',
    signed: 'This matches the signed document before the certificate page was appended. The content is intact.',
    original: 'This is the original upload, before any signatures were applied.',
  }[match];

  show(res, mode, {
    result: { sha, match, message, filename: req.file.originalname },
    lookup: { found: true, ...publicView(doc) },
    query: doc.id,
  });
};

/* --------------------------------------------------------------- public */

// The public face of the app lives at the root: someone handed a signed PDF
// can type the bare domain and check it.
router.get('/', blank('public'));
// The old location. Kept rather than removed — see the note on /verify/:id.
router.get('/verify', (req, res) => res.redirect(301, '/'));
// Permanent. This exact URL is printed on the certificate page inside every
// sealed PDF and encoded into QR-code fields, and those documents are immutable
// — re-pointing it would break verification for every document already issued.
router.get('/verify/:id', byId('public'));
// Registered on both paths: '/' so the address bar still reads as the root
// after a lookup, '/verify' because anything already pointing there — a
// bookmark, a script, a page someone saved — should keep working.
router.post(['/', '/verify'], lookup('public'));
router.post(['/check', '/verify/upload'], receivePdf('public'), check('public'));

/* --------------------------------------------------------------- in-app */

router.get('/verification', requireAuth, blank('app'));
router.post('/verification', requireAuth, lookup('app'));
router.post('/verification/upload', requireAuth, receivePdf('app'), check('app'));
router.get('/verification/:id', requireAuth, byId('app'));

export default router;
