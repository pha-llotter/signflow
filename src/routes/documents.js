import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { config } from '../config.js';
import { db, nowIso, audit } from '../db.js';
import { requireAuth, ownedDocument } from '../middleware/auth.js';
import { sha256Buffer, uuid, token } from '../crypto.js';
import { send, invitationEmail } from '../mailer.js';
import { mailConfigured } from '../settings-store.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF files can be uploaded.'), ok);
  },
});

/**
 * Multer rejects oversized and non-PDF uploads from inside middleware, which
 * in Express 5 skips straight past the route to the generic error handler.
 * Catching it here keeps the message on the form the user is looking at.
 */
function receivePdf(req, res, next) {
  upload.single('pdf')(req, res, (err) => {
    if (!err) return next();
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `That file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
        : err.message || 'That upload could not be read.';
    res.status(400).render('new', { error: message });
  });
}

router.get('/documents', requireAuth, (req, res) => {
  const docs = db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id) AS recipient_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id AND r.status = 'signed') AS signed_count
       FROM documents d WHERE d.owner_id = ? ORDER BY d.created_at DESC`
    )
    .all(req.user.id);

  const counts = docs.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});
  res.render('documents', { docs, counts, mailReady: mailConfigured() });
});

router.get('/documents/new', requireAuth, (req, res) => {
  res.render('new', { error: null });
});

router.post('/documents/new', requireAuth, receivePdf, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).render('new', { error: 'Choose a PDF to upload.' });

    let pdf;
    try {
      pdf = await PDFDocument.load(req.file.buffer, { ignoreEncryption: false });
    } catch {
      return res.status(400).render('new', {
        error: 'That PDF could not be read. Password-protected files must be unlocked first.',
      });
    }

    // Page geometry is captured now so the placer and the stamper both work
    // against the same boxes even if the source file is odd (rotated, mixed sizes).
    const pageSizes = pdf.getPages().map((p) => {
      const { width, height } = p.getSize();
      return { w: width, h: height, rotation: p.getRotation().angle };
    });

    const id = uuid();
    const sha = sha256Buffer(req.file.buffer);
    const storedPath = path.join(config.storageDir, 'originals', `${id}.pdf`);
    fs.writeFileSync(storedPath, req.file.buffer);

    const title = String(req.body.title || '').trim() || req.file.originalname.replace(/\.pdf$/i, '');
    const expiryDays = Math.min(Math.max(Number(req.body.expires_in_days) || 30, 1), 365);

    db.prepare(
      `INSERT INTO documents (id, owner_id, title, message, filename, page_count, page_sizes,
         original_path, original_sha256, status, signing_order, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`
    ).run(
      id,
      req.user.id,
      title,
      String(req.body.message || '').trim() || null,
      req.file.originalname,
      pageSizes.length,
      JSON.stringify(pageSizes),
      storedPath,
      sha,
      req.body.signing_order ? 1 : 0,
      new Date(Date.now() + expiryDays * 864e5).toISOString(),
      nowIso()
    );

    audit({
      documentId: id,
      actor: req.user.email,
      action: 'Envelope created',
      detail: `${req.file.originalname} · ${pageSizes.length} page(s) · SHA-256 ${sha}`,
      req,
    });

    // Recipients arrive as parallel arrays from the repeatable form rows.
    const names = [].concat(req.body.recipient_name || []);
    const emails = [].concat(req.body.recipient_email || []);
    const insert = db.prepare(
      `INSERT INTO recipients (id, document_id, name, email, order_index) VALUES (?, ?, ?, ?, ?)`
    );
    let index = 0;
    for (let i = 0; i < emails.length; i++) {
      const email = String(emails[i] || '').trim().toLowerCase();
      const name = String(names[i] || '').trim();
      if (!email || !name) continue;
      insert.run(uuid(), id, name, email, index++);
    }

    if (index === 0) {
      return res.status(400).render('new', { error: 'Add at least one recipient with a name and email.' });
    }

    res.redirect(`/documents/${id}/prepare`);
  } catch (err) {
    next(err);
  }
});

router.get('/documents/:id', requireAuth, ownedDocument, (req, res) => {
  const recipients = db
    .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(req.doc.id);
  const events = db
    .prepare('SELECT * FROM audit_events WHERE document_id = ? ORDER BY id DESC')
    .all(req.doc.id);
  res.render('document', { doc: req.doc, recipients, events, baseUrl: config.baseUrl });
});

/** Sends the envelope: issues one-time tokens and mails the signing links. */
router.post('/documents/:id/send', requireAuth, ownedDocument, async (req, res, next) => {
  try {
    const doc = req.doc;
    if (doc.status !== 'draft') {
      req.session.flash = { type: 'error', text: 'This document has already been sent.' };
      return res.redirect(`/documents/${doc.id}`);
    }

    const recipients = db
      .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
      .all(doc.id);
    const fieldCount = db
      .prepare('SELECT COUNT(*) AS n FROM fields WHERE document_id = ?')
      .get(doc.id).n;

    if (!recipients.length || fieldCount === 0) {
      req.session.flash = { type: 'error', text: 'Place at least one field before sending.' };
      return res.redirect(`/documents/${doc.id}/prepare`);
    }

    const setToken = db.prepare('UPDATE recipients SET token = ? WHERE id = ?');
    for (const r of recipients) setToken.run(token(), r.id);

    db.prepare(`UPDATE documents SET status = 'sent', sent_at = ? WHERE id = ?`).run(nowIso(), doc.id);
    audit({ documentId: doc.id, actor: req.user.email, action: 'Document sent', req });

    // With signing order on, only the first recipient is invited now; the rest
    // are invited as the one before them signs.
    const toInvite = doc.signing_order ? recipients.slice(0, 1) : recipients;
    const problems = [];
    for (const r of toInvite) {
      const result = await inviteRecipient({ doc, recipient: r, sender: req.user, req });
      if (!result.delivered) problems.push(`${r.email}: ${result.reason}`);
    }

    req.session.flash = problems.length
      ? { type: 'error', text: `Sent, but mail did not go out — ${problems.join('; ')}. Copy the signing links below instead.` }
      : { type: 'ok', text: `Invitation sent to ${toInvite.map((r) => r.email).join(', ')}.` };
    res.redirect(`/documents/${doc.id}`);
  } catch (err) {
    next(err);
  }
});

/** Shared by send and by the signing-order hand-off after each signature. */
export async function inviteRecipient({ doc, recipient, sender, req = null }) {
  const fresh = db.prepare('SELECT * FROM recipients WHERE id = ?').get(recipient.id);
  let tok = fresh.token;
  if (!tok) {
    tok = token();
    db.prepare('UPDATE recipients SET token = ? WHERE id = ?').run(tok, recipient.id);
  }
  const link = `${config.baseUrl}/sign/${tok}`;
  const mail = invitationEmail({ doc, recipient: fresh, sender, link });
  const result = await send(sender, { to: `"${fresh.name}" <${fresh.email}>`, ...mail });

  audit({
    documentId: doc.id,
    recipientId: fresh.id,
    actor: sender.email,
    action: result.delivered ? 'Email sent' : 'Email not delivered',
    detail: result.delivered ? `Invitation to ${fresh.email}` : `${fresh.email} — ${result.reason}`,
    req,
  });
  return result;
}

router.post('/documents/:id/remind', requireAuth, ownedDocument, async (req, res) => {
  const pending = db
    .prepare(`SELECT * FROM recipients WHERE document_id = ? AND status IN ('pending','viewed') ORDER BY order_index`)
    .all(req.doc.id);
  const target = req.doc.signing_order ? pending.slice(0, 1) : pending;
  for (const r of target) await inviteRecipient({ doc: req.doc, recipient: r, sender: req.user, req });
  req.session.flash = { type: 'ok', text: `Reminder sent to ${target.length} recipient(s).` };
  res.redirect(`/documents/${req.doc.id}`);
});

router.get('/documents/:id/original.pdf', requireAuth, ownedDocument, (req, res) => {
  res.type('application/pdf').sendFile(path.resolve(req.doc.original_path));
});

router.get('/documents/:id/signed.pdf', requireAuth, ownedDocument, (req, res) => {
  if (!req.doc.sealed_path) {
    return res.status(404).render('error', { code: 404, message: 'This document has not been sealed yet.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title.replace(/[^\w.-]+/g, '_')}-signed.pdf"`);
  res.type('application/pdf').sendFile(path.resolve(req.doc.sealed_path));
});

router.post('/documents/:id/delete', requireAuth, ownedDocument, (req, res) => {
  for (const p of [req.doc.original_path, req.doc.sealed_path]) {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.doc.id);
  req.session.flash = { type: 'ok', text: 'Document deleted.' };
  res.redirect('/documents');
});

export default router;
