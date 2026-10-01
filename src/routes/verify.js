import { Router } from 'express';
import multer from 'multer';
import { db } from '../db.js';
import { config } from '../config.js';
import { sha256Buffer } from '../crypto.js';
import { formatStamp } from '../certificate.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });

/** Keeps multer's rejections on the verify page rather than the 500 handler. */
function receivePdf(req, res, next) {
  upload.single('pdf')(req, res, (err) => {
    if (!err) return next();
    res.status(400).render('verify', {
      result: {
        error:
          err.code === 'LIMIT_FILE_SIZE'
            ? `That file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
            : err.message || 'That upload could not be read.',
      },
      lookup: null, query: '', formatStamp,
    });
  });
}

/**
 * Public verification. Deliberately shows only what a holder of the document
 * already knows — title, hashes, who signed and when — and never the file
 * itself, so a leaked document ID does not leak the contents.
 */
function publicView(doc) {
  const recipients = db
    .prepare('SELECT name, email, status, viewed_at, signed_at, last_ip FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(doc.id);
  const events = db
    .prepare('SELECT actor, action, detail, ip, created_at FROM audit_events WHERE document_id = ? ORDER BY id')
    .all(doc.id);
  const owner = db.prepare('SELECT display_name, email, org_name FROM users WHERE id = ?').get(doc.owner_id);
  return { doc, recipients, events, owner };
}

/**
 * Verification is the public face of the app, so it lives at the root: someone
 * handed a signed PDF can type the bare domain and check it.
 */
router.get('/', (req, res) => {
  res.render('verify', { result: null, lookup: null, query: '', formatStamp });
});

// The old location. Kept rather than removed — see the note on /verify/:id.
router.get('/verify', (req, res) => res.redirect(301, '/'));

/**
 * Permanent. This exact URL is printed on the certificate page inside every
 * sealed PDF and encoded into QR-code fields, and those documents are immutable
 * — re-pointing it would break verification for every document already issued.
 */
router.get('/verify/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) {
    return res.status(404).render('verify', {
      result: null, lookup: { found: false, id: req.params.id }, query: req.params.id, formatStamp,
    });
  }
  res.render('verify', { result: null, lookup: { found: true, ...publicView(doc) }, query: doc.id, formatStamp });
});

/**
 * Look up by document ID or by pasting either hash.
 *
 * Registered on both paths: '/' so the address bar still reads as the root
 * after a lookup, '/verify' because anything already pointing there — a
 * bookmark, a script, a page someone saved — should keep working.
 */
router.post(['/', '/verify'], (req, res) => {
  const q = String(req.body.query || '').trim();
  const doc = db
    .prepare('SELECT * FROM documents WHERE id = ? OR sealed_sha256 = ? OR signed_sha256 = ? OR original_sha256 = ?')
    .get(q, q.toLowerCase(), q.toLowerCase(), q.toLowerCase());
  if (!doc) {
    return res.status(404).render('verify', { result: null, lookup: { found: false, id: q }, query: q, formatStamp });
  }
  res.render('verify', { result: null, lookup: { found: true, ...publicView(doc) }, query: q, formatStamp });
});

/**
 * Hashes an uploaded file and reports which of the recorded hashes it matches.
 * This is the check that actually proves tampering: a byte changed anywhere in
 * the PDF produces a different digest and matches nothing.
 */
router.post(['/check', '/verify/upload'], receivePdf, (req, res) => {
  if (!req.file) {
    return res.status(400).render('verify', {
      result: { error: 'Choose a PDF to check.' }, lookup: null, query: '', formatStamp,
    });
  }
  const sha = sha256Buffer(req.file.buffer);
  const doc = db
    .prepare('SELECT * FROM documents WHERE sealed_sha256 = ? OR signed_sha256 = ? OR original_sha256 = ?')
    .get(sha, sha, sha);

  if (!doc) {
    return res.render('verify', {
      result: {
        sha, match: 'none', filename: req.file.originalname,
        message:
          'This file does not match any document we hold. Either it was not sealed here, or it has been altered since it was — even a single changed byte produces a different hash.',
      },
      lookup: null, query: '', formatStamp,
    });
  }

  const match =
    sha === doc.sealed_sha256 ? 'sealed' : sha === doc.signed_sha256 ? 'signed' : 'original';
  const message = {
    sealed: 'This is the sealed document exactly as it was issued, certificate of completion included. It has not been altered.',
    signed: 'This matches the signed document before the certificate page was appended. The content is intact.',
    original: 'This is the original upload, before any signatures were applied.',
  }[match];

  res.render('verify', {
    result: { sha, match, message, filename: req.file.originalname },
    lookup: { found: true, ...publicView(doc) },
    query: doc.id,
    formatStamp,
  });
});

export default router;
