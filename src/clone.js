import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { uuid } from './crypto.js';

/**
 * Copies a document's PDF, recipients and field layout into a new document.
 * Used both ways round: a template becomes a draft when it is used, and a
 * document becomes a template when it is saved as one.
 *
 * `people` lines up with the source's recipients in signing order — a role
 * label and no email when making a template, a real name and email when using
 * one. Field values are never copied: a template is a layout, not a filled-in
 * form, and a new envelope must start blank.
 *
 * The PDF is copied rather than shared, so deleting a template can never take
 * the file out from under a document that was made from it.
 */
export function cloneDocument(source, {
  ownerId, status, title, message = null, signingOrder = 0,
  expiresAt = null, visibility = null, templateId = null, people,
}) {
  const recipients = db
    .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(source.id);
  if (people.length !== recipients.length) throw new Error('Every recipient needs a counterpart.');

  const id = uuid();
  const storedPath = path.join(config.storageDir, 'originals', `${id}.pdf`);
  fs.copyFileSync(source.original_path, storedPath);

  const write = db.transaction(() => {
    db.prepare(
      `INSERT INTO documents (id, owner_id, title, message, filename, page_count, page_sizes,
         original_path, original_sha256, status, signing_order, expires_at, created_at,
         template_visibility, template_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, ownerId, title, message, source.filename, source.page_count, source.page_sizes,
      storedPath, source.original_sha256, status, signingOrder ? 1 : 0, expiresAt, nowIso(),
      visibility, templateId
    );

    const newIds = new Map();
    const insertRecipient = db.prepare(
      'INSERT INTO recipients (id, document_id, name, email, order_index) VALUES (?, ?, ?, ?, ?)'
    );
    recipients.forEach((r, i) => {
      const rid = uuid();
      newIds.set(r.id, rid);
      insertRecipient.run(rid, id, people[i].name, people[i].email, i);
    });

    const insertField = db.prepare(
      `INSERT INTO fields (id, document_id, recipient_id, type, page, x, y, w, h, required, font_size, align, color, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const f of db.prepare('SELECT * FROM fields WHERE document_id = ?').all(source.id)) {
      insertField.run(
        uuid(), id, f.recipient_id ? newIds.get(f.recipient_id) ?? null : null,
        f.type, f.page, f.x, f.y, f.w, f.h, f.required, f.font_size, f.align, f.color, f.meta
      );
    }
  });

  try {
    write();
  } catch (err) {
    fs.rmSync(storedPath, { force: true });
    throw err;
  }
  return id;
}
