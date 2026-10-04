import { db, nowIso } from './db.js';
import { encryptSecret } from './crypto.js';

/**
 * Platform-wide settings: the default outgoing mail every company uses unless
 * it brings its own. Singleton row, guaranteed to exist by the migration.
 */
export function platformSettings() {
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
}

export function companyById(id) {
  return id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(id) : null;
}

/**
 * The mail account a company's messages actually go out through: its own
 * server when it has configured one, otherwise the platform default. `source`
 * says which, so Settings can tell an administrator what is in effect.
 */
export function mailSettings(companyId) {
  const company = companyById(companyId);
  if (company?.smtp_host) return { ...company, source: 'company' };
  const platform = platformSettings();
  if (platform?.smtp_host) return { ...platform, source: 'platform' };
  return null;
}

export function mailConfigured(companyId) {
  return !!mailSettings(companyId);
}

/**
 * Writes the SMTP columns, which are the same on a company row and on the
 * platform row. A blank password means "keep what is stored" — it is never
 * sent to the browser, so there is nothing for the form to submit back — and
 * clearing the host clears the override entirely.
 */
function saveMail(table, id, current, values, actor) {
  const host = String(values.smtp_host || '').trim();
  const passEnc = values.smtp_pass ? encryptSecret(String(values.smtp_pass)) : current?.smtp_pass_enc;
  db.prepare(
    `UPDATE ${table} SET smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?, smtp_pass_enc = ?,
       from_name = ?, from_email = ?, updated_at = ?, updated_by = ?
     WHERE id = ?`
  ).run(
    host || null,
    host ? Number(values.smtp_port) || null : null,
    host && values.smtp_secure ? 1 : 0,
    host ? String(values.smtp_user || '').trim() || null : null,
    host ? passEnc : null,
    host ? String(values.from_name || '').trim() || null : null,
    host ? String(values.from_email || '').trim() || null : null,
    nowIso(),
    actor?.id ?? null,
    id
  );
}

export function savePlatformMail(values, actor) {
  saveMail('app_settings', 1, platformSettings(), values, actor);
}

/**
 * A company's name, and its own mail server unless it chose the platform's.
 * Each Settings section is its own form, so only what was submitted changes:
 * saving the name must never clear the mail server, and vice versa.
 */
export function saveCompanySettings(companyId, values, actor) {
  const current = companyById(companyId);
  const name = String(values.name || '').trim().slice(0, 120);
  if (name) db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, companyId);
  if (values.mail_source !== undefined) {
    saveMail('companies', companyId, current, values.mail_source === 'own' ? values : {}, actor);
  } else {
    db.prepare('UPDATE companies SET updated_at = ?, updated_by = ? WHERE id = ?').run(nowIso(), actor?.id ?? null, companyId);
  }
}
