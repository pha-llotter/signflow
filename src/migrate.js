/**
 * Schema migrations that `CREATE TABLE IF NOT EXISTS` cannot express.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so every step checks the current
 * shape first and does nothing when it is already applied. Running this on a
 * fresh database and on an existing one must both be safe, and it runs on every
 * boot — there is no separate migrate command to forget.
 */

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

export function migrate(db, nowIso) {
  const userCols = columns(db, 'users');

  const addUserColumn = (name, ddl) => {
    if (!userCols.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
  };

  addUserColumn('role', `TEXT NOT NULL DEFAULT 'member'`);
  addUserColumn('status', `TEXT NOT NULL DEFAULT 'active'`);
  addUserColumn('last_seen_at', 'TEXT');
  addUserColumn('invited_by', 'TEXT');

  // Templates are documents with status 'template': they reuse the stored PDF,
  // the field table and the placer. Their recipients are roles ("Parent"),
  // with an empty email until the template is used.
  const docCols = columns(db, 'documents');
  if (!docCols.has('template_visibility')) db.exec(`ALTER TABLE documents ADD COLUMN template_visibility TEXT`);
  // On a document made from a template, which one. Not a foreign key: deleting
  // the template must leave the documents made from it untouched.
  if (!docCols.has('template_id')) db.exec(`ALTER TABLE documents ADD COLUMN template_id TEXT`);

  // Ensure the settings singleton exists before anything tries to read it.
  db.prepare('INSERT OR IGNORE INTO app_settings (id, updated_at) VALUES (1, ?)').run(nowIso());

  // An installation that predates roles has no admin at all, which would lock
  // everyone out of Settings and the team page. The founding account — the
  // oldest one — becomes the administrator.
  const admins = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n;
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (admins === 0 && total > 0) {
    const first = db.prepare('SELECT id, email FROM users ORDER BY created_at, rowid LIMIT 1').get();
    db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(first.id);
    db.prepare(
      `INSERT INTO admin_events (actor_id, actor_email, action, subject, detail, created_at)
       VALUES (?, ?, 'Promoted to administrator', ?, 'Automatic: oldest account, no administrator existed', ?)`
    ).run(null, 'system', first.email, nowIso());
    console.log(`[migrate] ${first.email} promoted to administrator (no admin existed)`);
  }

  // Outgoing mail used to be configured per user. Carry the first configured
  // account's settings up to the installation-wide record so an existing
  // deployment keeps sending after the upgrade instead of going silent.
  if (userCols.has('smtp_host')) {
    const settings = db.prepare('SELECT smtp_host FROM app_settings WHERE id = 1').get();
    if (!settings?.smtp_host) {
      const donor = db
        .prepare(`SELECT * FROM users WHERE smtp_host IS NOT NULL AND smtp_host != '' ORDER BY role = 'admin' DESC, created_at LIMIT 1`)
        .get();
      if (donor) {
        db.prepare(
          `UPDATE app_settings SET smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?,
             smtp_pass_enc = ?, from_name = ?, from_email = ?, updated_at = ?, updated_by = ?
           WHERE id = 1`
        ).run(
          donor.smtp_host, donor.smtp_port, donor.smtp_secure, donor.smtp_user,
          donor.smtp_pass_enc, donor.smtp_from_name, donor.smtp_from_email,
          nowIso(), donor.id
        );
        console.log(`[migrate] outgoing mail settings moved from ${donor.email} to the installation`);
      }
    }
  }
}
