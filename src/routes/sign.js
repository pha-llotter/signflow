import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, audit, clientIp } from '../db.js';
import { config } from '../config.js';
import { sha256Buffer, uuid } from '../crypto.js';
import { FIELD_TYPES, isSignerFilled } from '../fields.js';
import { sealDocument } from '../seal.js';
import { send, completionEmail, declinedEmail } from '../mailer.js';
import { inviteRecipient } from './documents.js';

const router = Router();

/**
 * Resolves a signing token to its recipient and document, and refuses the
 * link if the envelope is not in a state that can accept a signature.
 * Every rejection path renders the same neutral page shape so a token cannot
 * be probed for which of the failures applies.
 */
function loadByToken(req, res, next) {
  const tok = String(req.params.token || '');
  const recipient = db.prepare('SELECT * FROM recipients WHERE token = ?').get(tok);
  if (!recipient) {
    return res.status(404).render('sign-closed', {
      heading: 'This signing link is not valid',
      message: 'The link may have been mistyped, or it may have been replaced by a newer one. Ask the sender to resend it.',
    });
  }

  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(recipient.document_id);
  // org_name is the sender's company, so the signer sees who is really asking.
  const owner = db
    .prepare('SELECT u.*, c.name AS org_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?')
    .get(doc.owner_id);

  if (doc.expires_at && new Date(doc.expires_at) < new Date() && doc.status !== 'completed') {
    return res.status(410).render('sign-closed', {
      heading: 'This document has expired',
      message: `"${doc.title}" expired on ${new Date(doc.expires_at).toDateString()}. Ask ${owner.display_name} to send it again.`,
    });
  }
  if (recipient.status === 'signed') {
    return res.render('sign-closed', {
      heading: 'You have already signed this',
      message: `Your signature on "${doc.title}" was recorded on ${new Date(recipient.signed_at).toLocaleString()}. Nothing further is needed from you.`,
    });
  }
  if (recipient.status === 'declined') {
    return res.render('sign-closed', {
      heading: 'You declined this document',
      message: `You declined to sign "${doc.title}". Contact ${owner.display_name} if that was a mistake.`,
    });
  }
  if (doc.status === 'completed' || doc.status === 'declined') {
    return res.render('sign-closed', {
      heading: 'This document is closed',
      message: `"${doc.title}" is no longer open for signing.`,
    });
  }
  // With signing order on, a later recipient's link must not open early even
  // if they were forwarded one.
  if (doc.signing_order) {
    const ahead = db
      .prepare(
        `SELECT COUNT(*) AS n FROM recipients
         WHERE document_id = ? AND order_index < ? AND status != 'signed'`
      )
      .get(doc.id, recipient.order_index).n;
    if (ahead > 0) {
      return res.render('sign-closed', {
        heading: 'Not your turn yet',
        message: `"${doc.title}" is being signed in order. You will get an email the moment it reaches you.`,
      });
    }
  }

  req.recipient = recipient;
  req.doc = doc;
  req.owner = owner;
  next();
}

router.get('/sign/:token', loadByToken, (req, res) => {
  const { doc, recipient, owner } = req;

  if (!recipient.viewed_at) {
    db.prepare(`UPDATE recipients SET status = 'viewed', viewed_at = ?, last_ip = ?, user_agent = ? WHERE id = ?`)
      .run(nowIso(), clientIp(req), String(req.get('user-agent') || '').slice(0, 400), recipient.id);
    audit({
      documentId: doc.id, recipientId: recipient.id, actor: recipient.name,
      action: 'Opened the document', req,
    });
  }

  const fields = db
    .prepare('SELECT * FROM fields WHERE document_id = ? ORDER BY page, y, x')
    .all(doc.id)
    .map((f) => ({ ...f, meta: f.meta ? JSON.parse(f.meta) : {} }));

  res.render('sign', {
    doc,
    owner,
    recipient,
    // The signer sees every field on the page for context, but only fills
    // the ones addressed to them.
    fields,
    myFields: fields.filter((f) => f.recipient_id === recipient.id && isSignerFilled(f.type)),
    pageSizes: JSON.parse(doc.page_sizes || '[]'),
    fieldTypes: FIELD_TYPES,
    token: req.params.token,
    dataRegion: config.dataRegion,
  });
});

/** Serves the PDF bytes to a signer, authorised purely by their token. */
router.get('/sign/:token/document.pdf', loadByToken, (req, res) => {
  res.type('application/pdf').sendFile(path.resolve(req.doc.original_path));
});

router.post('/sign/:token/decline', loadByToken, async (req, res) => {
  const { doc, recipient, owner } = req;
  const note = String(req.body.reason || '').trim().slice(0, 500);

  db.prepare(`UPDATE recipients SET status = 'declined', declined_at = ?, decline_note = ?, last_ip = ? WHERE id = ?`)
    .run(nowIso(), note || null, clientIp(req), recipient.id);
  db.prepare(`UPDATE documents SET status = 'declined' WHERE id = ?`).run(doc.id);
  audit({
    documentId: doc.id, recipientId: recipient.id, actor: recipient.name,
    action: 'Declined to sign', detail: note || null, req,
  });

  await send(owner, { to: owner.email, ...declinedEmail({ doc, recipient, reason: note }) });

  res.render('sign-closed', {
    heading: 'You declined this document',
    message: `${owner.display_name} has been told that you declined to sign "${doc.title}".`,
  });
});

router.post('/sign/:token', loadByToken, async (req, res, next) => {
  try {
    const { doc, recipient, owner } = req;

    // POPIA: the signer must actively consent before anything is recorded
    // against their name. The checkbox is the record of that consent.
    if (!req.body.consent) {
      return res.status(400).json({ error: 'Please confirm your consent to sign electronically before continuing.' });
    }

    const mine = db
      .prepare('SELECT * FROM fields WHERE document_id = ? AND recipient_id = ?')
      .all(doc.id, recipient.id);
    const values = req.body.values || {};

    const missing = [];
    for (const f of mine) {
      if (!isSignerFilled(f.type)) continue;
      const v = values[f.id];
      const empty = v == null || v === '' || v === false;
      if (f.required && empty) missing.push(FIELD_TYPES[f.type]?.label || f.type);
    }
    if (missing.length) {
      return res.status(400).json({ error: `Still to complete: ${[...new Set(missing)].join(', ')}.` });
    }

    const signedAt = nowIso();
    const setValue = db.prepare('UPDATE fields SET value = ? WHERE id = ?');
    const saved = saveAttachments({ doc, fields: mine, files: req.body.files || {} });

    const apply = db.transaction(() => {
      for (const f of mine) {
        let v = values[f.id];
        // System-filled types are never taken from the request body — they are
        // derived here so a signer cannot backdate or rename their own signature.
        if (f.type === 'date_signed') v = new Date(signedAt).toISOString().slice(0, 10);
        else if (f.type === 'name') v = recipient.name;
        else if (f.type === 'email') v = recipient.email;
        else if (f.type === 'checkbox') v = v ? 'true' : 'false';
        else if (v == null) v = '';
        setValue.run(String(v), f.id);
      }
      db.prepare(
        `UPDATE recipients SET status = 'signed', signed_at = ?, consent_at = ?, last_ip = ?, user_agent = ? WHERE id = ?`
      ).run(signedAt, signedAt, clientIp(req), String(req.get('user-agent') || '').slice(0, 400), recipient.id);
    });
    apply();

    audit({
      documentId: doc.id, recipientId: recipient.id, actor: recipient.name,
      action: 'Consent recorded',
      detail: 'Agreed to sign electronically and to this audit trail being kept',
      req,
    });
    audit({
      documentId: doc.id, recipientId: recipient.id, actor: recipient.name,
      action: 'Signature applied', req,
    });
    for (const a of saved) {
      audit({
        documentId: doc.id, recipientId: recipient.id, actor: recipient.name,
        action: 'File attached', detail: `${a.filename} · SHA-256 ${a.sha256}`, req,
      });
    }

    const outstanding = db
      .prepare(`SELECT * FROM recipients WHERE document_id = ? AND status != 'signed' ORDER BY order_index`)
      .all(doc.id);

    if (outstanding.length === 0) {
      // Two people finishing at the same moment must not both seal. The
      // conditional update is the lock: exactly one request wins the row.
      const won = db
        .prepare(`UPDATE documents SET status = 'completed', completed_at = ? WHERE id = ? AND status != 'completed'`)
        .run(signedAt, doc.id).changes === 1;

      if (won) {
        audit({ documentId: doc.id, actor: 'System', action: 'Document completed', req });

        // A failure here must not lose a signature that is already recorded —
        // the signer is told it went through, and the seal can be retried.
        try {
          const { sealedSha, bytes } = await sealDocument(doc.id);
          audit({
            documentId: doc.id, actor: 'System', action: 'Document sealed',
            detail: `Certificate appended · sealed SHA-256 ${sealedSha}`,
          });

          const sealedDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(doc.id);
          const attachment = {
            filename: `${doc.title.replace(/[^\w.-]+/g, '_')}-signed.pdf`,
            content: bytes,
            contentType: 'application/pdf',
          };
          // Each person gets a download link they can actually use: the owner
          // through their account, every signer through their own token.
          const everyone = db.prepare('SELECT * FROM recipients WHERE document_id = ?').all(doc.id);
          const targets = [
            { email: owner.email, url: `${config.baseUrl}/documents/${doc.id}/signed.pdf` },
            ...everyone.map((r) => ({
              email: r.email,
              url: r.token ? `${config.baseUrl}/sign/${r.token}/signed.pdf` : `${config.baseUrl}/verify/${doc.id}`,
            })),
          ];
          for (const t of targets) {
            const mail = completionEmail({ doc: sealedDoc, sender: owner, downloadUrl: t.url, attachment });
            await send(owner, { to: t.email, ...mail });
          }
        } catch (err) {
          console.error(`[seal:failed] document=${doc.id}: ${err.stack}`);
          audit({
            documentId: doc.id, actor: 'System', action: 'Sealing failed',
            detail: err.message,
          });
        }
      }
    } else if (doc.signing_order) {
      // Hand off to the next signer in line.
      await inviteRecipient({ doc, recipient: outstanding[0], sender: owner, req });
    }

    res.json({ ok: true, redirect: `/sign/${req.params.token}/done` });
  } catch (err) {
    next(err);
  }
});

/**
 * Persists files dropped into attachment fields. They are hashed on arrival
 * like the document itself, so the audit trail can show that what was attached
 * is what ended up on the back of the sealed PDF.
 */
function saveAttachments({ doc, fields, files }) {
  const out = [];
  const insert = db.prepare(
    `INSERT INTO attachments (id, document_id, field_id, filename, mime, path, sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const f of fields) {
    if (f.type !== 'attachment') continue;
    const payload = files[f.id];
    const m = /^data:([\w.+/-]+);base64,(.+)$/.exec(String(payload?.dataUrl || ''));
    if (!m) continue;

    const mime = m[1];
    if (!/^(application\/pdf|image\/(png|jpeg))$/.test(mime)) continue;

    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 8 * 1024 * 1024) continue;

    const id = uuid();
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
    const dest = path.join(config.storageDir, 'uploads', `${id}.${ext}`);
    fs.writeFileSync(dest, bytes);

    const record = {
      id,
      filename: String(payload.name || `attachment.${ext}`).slice(0, 200),
      mime,
      path: dest,
      sha256: sha256Buffer(bytes),
    };
    insert.run(record.id, doc.id, f.id, record.filename, record.mime, record.path, record.sha256, nowIso());
    out.push(record);
  }
  return out;
}

router.get('/sign/:token/done', (req, res) => {
  const recipient = db.prepare('SELECT * FROM recipients WHERE token = ?').get(String(req.params.token));
  if (!recipient) return res.status(404).render('error', { code: 404, message: 'Unknown signing link.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(recipient.document_id);
  res.render('sign-done', { doc, recipient, baseUrl: config.baseUrl });
});

/** Lets a signer download the sealed copy from their own link once it is done. */
router.get('/sign/:token/signed.pdf', (req, res) => {
  const recipient = db.prepare('SELECT * FROM recipients WHERE token = ?').get(String(req.params.token));
  if (!recipient) return res.status(404).render('error', { code: 404, message: 'Unknown signing link.' });
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(recipient.document_id);
  if (!doc.sealed_path) {
    return res.status(404).render('error', { code: 404, message: 'This document has not been sealed yet.' });
  }
  res.setHeader('Content-Disposition', `attachment; filename="${doc.title.replace(/[^\w.-]+/g, '_')}-signed.pdf"`);
  res.type('application/pdf').sendFile(path.resolve(doc.sealed_path));
});

export default router;
