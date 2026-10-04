import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { config } from '../config.js';
import { db, nowIso, audit } from '../db.js';
import { requireAuth, ownedDocument, canUseTemplate } from '../middleware/auth.js';
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

const DOC_STATUSES = ['draft', 'sent', 'completed', 'declined'];

router.get('/documents', requireAuth, (req, res) => {
  const all = db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id) AS recipient_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id AND r.status = 'signed') AS signed_count,
              (SELECT group_concat(name || ' ' || email, ' ') FROM recipients r WHERE r.document_id = d.id) AS recipient_text
       FROM documents d WHERE d.owner_id = ? AND d.status != 'template' AND d.deleted_at IS NULL ORDER BY d.created_at DESC`
    )
    .all(req.user.id);

  // Counts describe everything the user owns, so the filter tabs keep their
  // numbers while one of them is selected.
  const counts = all.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});
  const status = DOC_STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = String(req.query.q || '').trim().slice(0, 100);
  const needle = q.toLowerCase();

  const docs = all.filter(
    (d) =>
      (!status || d.status === status) &&
      (!needle || [d.title, d.filename, d.recipient_text].some((s) => String(s || '').toLowerCase().includes(needle)))
  );
  res.render('documents', { docs, total: all.length, counts, status, q, mailReady: mailConfigured(req.user.company_id) });
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
         original_path, original_sha256, status, signing_order, expires_at, created_at, company_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`
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
      nowIso(),
      req.user.company_id
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

/* ------------------------------------------------------------------ trash */

/**
 * Deleting is two steps. A document first goes to the trash — out of every
 * list, its signing links closed — where it can be restored exactly as it was.
 * Only from the trash can it be deleted for good, and only that removes the
 * records and the files. A misclick on a signed contract should never be the
 * end of it.
 */
function trashed(ownerId) {
  return db
    .prepare(
      `SELECT d.*,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id) AS recipient_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id AND r.status = 'signed') AS signed_count
       FROM documents d
       WHERE d.owner_id = ? AND d.status != 'template' AND d.deleted_at IS NOT NULL
       ORDER BY d.deleted_at DESC`
    )
    .all(ownerId);
}

/** Removes a document for good: its rows (recipients, fields, audit trail cascade) and every file it owns. */
function purge(doc) {
  const files = [
    doc.original_path,
    doc.sealed_path,
    ...db.prepare('SELECT path FROM attachments WHERE document_id = ?').all(doc.id).map((a) => a.path),
  ].filter(Boolean);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  for (const p of files) fs.rmSync(p, { force: true });
}

router.get('/documents/trash', requireAuth, (req, res) => {
  res.render('trash', { docs: trashed(req.user.id) });
});

router.post('/documents/trash/empty', requireAuth, (req, res) => {
  const docs = trashed(req.user.id);
  for (const d of docs) purge(d);
  req.session.flash = { type: 'ok', text: docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'} permanently deleted.` : 'The trash was already empty.' };
  res.redirect('/documents/trash');
});

router.post('/documents/:id/delete', requireAuth, ownedDocument, (req, res) => {
  if (!req.doc.deleted_at) {
    db.prepare('UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(nowIso(), req.user.id, req.doc.id);
    audit({ documentId: req.doc.id, actor: req.user.email, action: 'Moved to trash', req });
  }
  req.session.flash = { type: 'ok', text: `“${req.doc.title}” moved to the trash. You can restore it from there.` };
  res.redirect('/documents');
});

router.post('/documents/:id/restore', requireAuth, ownedDocument, (req, res) => {
  if (req.doc.deleted_at) {
    db.prepare('UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(req.doc.id);
    audit({ documentId: req.doc.id, actor: req.user.email, action: 'Restored from trash', req });
  }
  req.session.flash = { type: 'ok', text: `“${req.doc.title}” restored.` };
  res.redirect(`/documents/${req.doc.id}`);
});

/** Permanent — and refused for anything not already in the trash. */
router.post('/documents/:id/purge', requireAuth, ownedDocument, (req, res) => {
  if (!req.doc.deleted_at) {
    req.session.flash = { type: 'error', text: 'Move a document to the trash before deleting it permanently.' };
    return res.redirect(`/documents/${req.doc.id}`);
  }
  purge(req.doc);
  req.session.flash = { type: 'ok', text: `“${req.doc.title}” permanently deleted.` };
  res.redirect('/documents/trash');
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

/**
 * Sends a draft: issues one-time tokens and mails the signing links. Shared by
 * the placer's Send button and by "Send now" on a template. Returns the flash
 * to show and where to go next.
 */
export async function sendDocument({ doc, user, req }) {
  if (doc.deleted_at) {
    return { flash: { type: 'error', text: 'This document is in the trash. Restore it before sending.' }, to: `/documents/${doc.id}` };
  }
  if (doc.status !== 'draft') {
    return { flash: { type: 'error', text: 'This document has already been sent.' }, to: `/documents/${doc.id}` };
  }

  const recipients = db
    .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(doc.id);
  const fieldCount = db
    .prepare('SELECT COUNT(*) AS n FROM fields WHERE document_id = ?')
    .get(doc.id).n;

  if (!recipients.length || fieldCount === 0) {
    return { flash: { type: 'error', text: 'Place at least one field before sending.' }, to: `/documents/${doc.id}/prepare` };
  }

  const setToken = db.prepare('UPDATE recipients SET token = ? WHERE id = ?');
  for (const r of recipients) setToken.run(token(), r.id);

  db.prepare(`UPDATE documents SET status = 'sent', sent_at = ? WHERE id = ?`).run(nowIso(), doc.id);
  audit({ documentId: doc.id, actor: user.email, action: 'Document sent', req });

  // With signing order on, only the first recipient is invited now; the rest
  // are invited as the one before them signs.
  const toInvite = doc.signing_order ? recipients.slice(0, 1) : recipients;
  const problems = [];
  for (const r of toInvite) {
    const result = await inviteRecipient({ doc, recipient: r, sender: user, req });
    if (!result.delivered) problems.push(`${r.email}: ${result.reason}`);
  }

  return {
    flash: problems.length
      ? { type: 'error', text: `Sent, but mail did not go out — ${problems.join('; ')}. Copy the signing links below instead.` }
      : { type: 'ok', text: `Invitation sent to ${toInvite.map((r) => r.email).join(', ')}.` },
    to: `/documents/${doc.id}`,
  };
}

router.post('/documents/:id/send', requireAuth, ownedDocument, async (req, res, next) => {
  try {
    const { flash, to } = await sendDocument({ doc: req.doc, user: req.user, req });
    req.session.flash = flash;
    res.redirect(to);
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
  // A draft has not been sent, so there is nothing to remind anyone about —
  // and inviting from here would send it without going through Send.
  if (req.doc.status !== 'sent' || req.doc.deleted_at) return res.redirect(`/documents/${req.doc.id}`);
  const pending = db
    .prepare(`SELECT * FROM recipients WHERE document_id = ? AND status IN ('pending','viewed') ORDER BY order_index`)
    .all(req.doc.id);
  const target = req.doc.signing_order ? pending.slice(0, 1) : pending;
  for (const r of target) await inviteRecipient({ doc: req.doc, recipient: r, sender: req.user, req });
  req.session.flash = { type: 'ok', text: `Reminder sent to ${target.length} recipient(s).` };
  res.redirect(`/documents/${req.doc.id}`);
});

/**
 * The placer and the template pages load the PDF from here, so besides the
 * owner of a document it also serves a template to anyone who may use it.
 */
function readableOriginal(req, res, next) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  const ok = doc && (doc.status === 'template' ? canUseTemplate(req.user, doc) : doc.owner_id === req.user.id);
  if (!ok) return res.status(404).render('error', { code: 404, message: 'Document not found.' });
  req.doc = doc;
  next();
}

router.get('/documents/:id/original.pdf', requireAuth, readableOriginal, (req, res) => {
  res.type('application/pdf').sendFile(path.resolve(req.doc.original_path));
});

router.get('/documents/:id/signed.pdf', requireAuth, ownedDocument, (req, res) => {
  if (!req.doc.sealed_path) {
    return res.status(404).render('error', { code: 404, message: 'This document has not been sealed yet.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${req.doc.title.replace(/[^\w.-]+/g, '_')}-signed.pdf"`);
  res.type('application/pdf').sendFile(path.resolve(req.doc.sealed_path));
});


export default router;
