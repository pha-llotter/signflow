PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  org_name        TEXT,
  created_at      TEXT NOT NULL,
  -- Per-account SMTP so invitations come from the sender's own address.
  smtp_host       TEXT,
  smtp_port       INTEGER,
  smtp_secure     INTEGER DEFAULT 0,
  smtp_user       TEXT,
  smtp_pass_enc   TEXT,
  smtp_from_name  TEXT,
  smtp_from_email TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  message          TEXT,
  filename         TEXT NOT NULL,
  page_count       INTEGER NOT NULL DEFAULT 0,
  -- Page geometry in PDF points, as JSON [{w,h}], so the placer and the
  -- stamper agree on where a normalised coordinate lands.
  page_sizes       TEXT,
  original_path    TEXT NOT NULL,
  original_sha256  TEXT NOT NULL,
  -- Hash of the flattened PDF *before* the certificate page is appended.
  -- Printed on the certificate; a certificate cannot contain its own hash.
  signed_sha256    TEXT,
  sealed_path      TEXT,
  -- Hash of the final file including the certificate. Used by /verify.
  sealed_sha256    TEXT,
  status           TEXT NOT NULL DEFAULT 'draft',
  signing_order    INTEGER NOT NULL DEFAULT 0,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  sent_at          TEXT,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recipients (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  order_index  INTEGER NOT NULL DEFAULT 0,
  token        TEXT UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending',
  consent_at   TEXT,
  viewed_at    TEXT,
  signed_at    TEXT,
  declined_at  TEXT,
  decline_note TEXT,
  last_ip      TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_recipients_doc ON recipients(document_id, order_index);

CREATE TABLE IF NOT EXISTS fields (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES recipients(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  page         INTEGER NOT NULL,
  -- All normalised 0..1 against the page box; y measured from the page top.
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  w            REAL NOT NULL,
  h            REAL NOT NULL,
  required     INTEGER NOT NULL DEFAULT 1,
  font_size    REAL DEFAULT 11,
  align        TEXT DEFAULT 'left',
  color        TEXT DEFAULT '#111111',
  -- Type-specific extras: dropdown options, label text, stamp wording, etc.
  meta         TEXT,
  value        TEXT
);
CREATE INDEX IF NOT EXISTS idx_fields_doc ON fields(document_id, page);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_id     TEXT REFERENCES fields(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime         TEXT,
  path         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- One row, id = 1. Outgoing mail is configured once for the whole
-- installation by an admin rather than per user: members cannot reach Settings,
-- so per-user SMTP would leave their invitations unable to send at all.
CREATE TABLE IF NOT EXISTS app_settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  org_name       TEXT,
  smtp_host      TEXT,
  smtp_port      INTEGER,
  smtp_secure    INTEGER DEFAULT 0,
  smtp_user      TEXT,
  smtp_pass_enc  TEXT,
  from_name      TEXT,
  from_email     TEXT,
  updated_at     TEXT,
  updated_by     TEXT
);

CREATE TABLE IF NOT EXISTS invitations (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL COLLATE NOCASE,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT NOT NULL UNIQUE,
  invited_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- Admin-issued, because closing public sign-up also closes the only route a
-- member had to recover an account.
CREATE TABLE IF NOT EXISTS password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  issued_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);

-- Separate from audit_events, which belongs to a document. Who was invited,
-- promoted or deactivated is a different record with a different lifetime — it
-- must survive the deletion of every document those people touched.
CREATE TABLE IF NOT EXISTS admin_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    TEXT,
  actor_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  subject     TEXT,
  detail      TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_events_time ON admin_events(id DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  detail       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_doc ON audit_events(document_id, id);
