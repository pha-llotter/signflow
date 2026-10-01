import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new Database(config.dbPath);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

export const nowIso = () => new Date().toISOString();

migrate(db, nowIso);

/** Records a change to people or installation settings, not to a document. */
export function adminLog({ actor, action, subject = null, detail = null, req = null }) {
  db.prepare(
    `INSERT INTO admin_events (actor_id, actor_email, action, subject, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    actor?.id ?? null,
    actor?.email ?? 'system',
    action,
    subject,
    detail,
    req ? clientIp(req) : null,
    nowIso()
  );
}

/**
 * Append an audit event. Every state change on a document goes through here —
 * the certificate of completion is rendered straight from this table, so an
 * action that is not recorded here did not happen as far as the evidence goes.
 */
export function audit({ documentId, recipientId = null, actor, action, detail = null, req = null }) {
  db.prepare(
    `INSERT INTO audit_events (document_id, recipient_id, actor, action, detail, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    documentId,
    recipientId,
    actor,
    action,
    detail,
    req ? clientIp(req) : null,
    req ? String(req.get('user-agent') || '').slice(0, 400) : null,
    nowIso()
  );
}

/** Honours X-Forwarded-For only when the app is explicitly behind a proxy. */
export function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
