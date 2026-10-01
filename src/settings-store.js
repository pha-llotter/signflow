import { db, nowIso } from './db.js';
import { encryptSecret } from './crypto.js';

/**
 * Installation-wide settings — currently outgoing mail and the organisation
 * name. Singleton row, guaranteed to exist by the migration.
 */
export function appSettings() {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
}

export function mailConfigured() {
  return !!appSettings()?.smtp_host;
}

export function saveAppSettings(values, actor) {
  const current = appSettings();
  const host = String(values.smtp_host || '').trim();

  // A blank password field means "keep what is stored" — it is never sent to
  // the browser, so there is nothing for the form to submit back.
  const passEnc = values.smtp_pass ? encryptSecret(String(values.smtp_pass)) : current.smtp_pass_enc;

  db.prepare(
    `UPDATE app_settings SET org_name = ?, smtp_host = ?, smtp_port = ?, smtp_secure = ?,
       smtp_user = ?, smtp_pass_enc = ?, from_name = ?, from_email = ?, updated_at = ?, updated_by = ?
     WHERE id = 1`
  ).run(
    String(values.org_name || '').trim() || null,
    host || null,
    Number(values.smtp_port) || null,
    values.smtp_secure ? 1 : 0,
    String(values.smtp_user || '').trim() || null,
    host ? passEnc : null,
    String(values.from_name || '').trim() || null,
    String(values.from_email || '').trim() || null,
    nowIso(),
    actor?.id ?? null
  );
}
