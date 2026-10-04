/**
 * Schema migrations that `CREATE TABLE IF NOT EXISTS` cannot express.
 *
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so every step checks the current
 * shape first and does nothing when it is already applied. Running this on a
 * fresh database and on an existing one must both be safe, and it runs on every
 * boot — there is no separate migrate command to forget.
 */

import crypto from 'node:crypto';

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
  // Multi-company: every account belongs to one company, and the platform
  // owner — whoever runs this server — is flagged separately from the
  // per-company administrator role.
  addUserColumn('company_id', 'TEXT');
  addUserColumn('platform_admin', 'INTEGER NOT NULL DEFAULT 0');

  const addColumn = (table, name, ddl) => {
    if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  };
  addColumn('invitations', 'company_id', 'TEXT');
  // NULL on a platform-level event (a company created or suspended).
  addColumn('admin_events', 'company_id', 'TEXT');
  // Denormalised from the owner so team templates and company-wide queries do
  // not have to join through users for every row.
  addColumn('documents', 'company_id', 'TEXT');
  // Deleting a document moves it to the trash first; only emptying the trash
  // removes it. deleted_at set means "in the trash".
  addColumn('documents', 'deleted_at', 'TEXT');
  addColumn('documents', 'deleted_by', 'TEXT');
  // Automatic reminders: every N days while unsigned (0 = off), and when the
  // last round went out so the next is counted from there.
  addColumn('documents', 'reminder_days', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('documents', 'last_reminded_at', 'TEXT');
  // A company's own logo, for its certificates, emails and sidebar. Pixel size
  // is kept so layouts can be computed without decoding the image each time.
  addColumn('companies', 'logo_path', 'TEXT');
  addColumn('companies', 'logo_width', 'INTEGER');
  addColumn('companies', 'logo_height', 'INTEGER');
  addColumn('companies', 'logo_updated_at', 'TEXT');

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

  // A single-organisation installation becomes the first company. Its name is
  // whatever the installation was called; its mail stays where it was, in
  // app_settings, which is now the platform default every company falls back
  // to — so nothing about how mail goes out changes on upgrade.
  const companyCount = db.prepare('SELECT COUNT(*) AS n FROM companies').get().n;
  if (companyCount === 0 && total > 0) {
    const s = db.prepare('SELECT org_name FROM app_settings WHERE id = 1').get();
    const named = db.prepare(`SELECT org_name FROM users WHERE org_name IS NOT NULL AND org_name != '' ORDER BY created_at LIMIT 1`).get();
    const name = s?.org_name || named?.org_name || 'My organisation';
    const id = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`INSERT INTO companies (id, name, status, created_at) VALUES (?, ?, 'active', ?)`).run(id, name, nowIso());
      for (const table of ['users', 'documents', 'invitations', 'admin_events']) {
        db.prepare(`UPDATE ${table} SET company_id = ? WHERE company_id IS NULL`).run(id);
      }
    })();
    console.log(`[migrate] existing data moved into company "${name}"`);
  }

  // A document belongs to its owner's company.
  db.prepare(
    `UPDATE documents SET company_id = (SELECT company_id FROM users u WHERE u.id = documents.owner_id)
     WHERE company_id IS NULL`
  ).run();

  // Someone has to be able to reach the platform pages. On an installation
  // that predates them, that is the founding administrator.
  const owners = db.prepare('SELECT COUNT(*) AS n FROM users WHERE platform_admin = 1').get().n;
  if (owners === 0 && total > 0) {
    const first = db.prepare(`SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at, rowid LIMIT 1`).get();
    if (first) {
      db.prepare('UPDATE users SET platform_admin = 1 WHERE id = ?').run(first.id);
      db.prepare(
        `INSERT INTO admin_events (actor_id, actor_email, action, subject, detail, created_at, company_id)
         VALUES (NULL, 'system', 'Made platform owner', ?, 'Automatic: founding administrator, no platform owner existed', ?, NULL)`
      ).run(first.email, nowIso());
      console.log(`[migrate] ${first.email} is the platform owner`);
    }
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
