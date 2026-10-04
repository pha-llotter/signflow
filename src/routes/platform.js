import { Router } from 'express';
import fs from 'node:fs';
import { config } from '../config.js';
import { db, nowIso, adminLog } from '../db.js';
import { requirePlatform } from '../middleware/auth.js';
import { token, uuid } from '../crypto.js';
import { send, verifySmtp, invitationToJoinEmail, smtpTestEmail } from '../mailer.js';
import { companyById, mailConfigured, platformSettings, savePlatformMail } from '../settings-store.js';
import { startSupport, SUPPORT_MINUTES } from '../support.js';
import { removeCompanyLogo } from '../company-logo.js';
import { logoHandler } from './settings.js';

/**
 * The platform owner's pages: the companies on this server, who administers
 * them, and whether they are switched on.
 *
 * Deliberately an overview. Counts, people and the administration log — never
 * a document, a recipient or a signature. Each company's documents are its own
 * business, and a platform owner who could read them all would be one more
 * party every signer's data was exposed to.
 */
const router = Router();
router.use('/platform', requirePlatform);

const INVITE_DAYS = 7;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const back = (req, res, to, type, text) => {
  req.session.flash = { type, text };
  res.redirect(to);
};

function loadCompany(req, res, next) {
  const company = companyById(req.params.id);
  if (!company) return res.status(404).render('error', { code: 404, message: 'Company not found.' });
  req.target = company;
  next();
}

/**
 * Issues an administrator invitation into a company and emails it through that
 * company's mail — the platform default, for a company that has just been made.
 */
async function inviteAdmin(req, company, email) {
  db.prepare(
    `UPDATE invitations SET revoked_at = ? WHERE email = ? AND company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
  ).run(nowIso(), email, company.id);

  const tok = token();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  db.prepare(
    `INSERT INTO invitations (id, email, role, token, invited_by, created_at, expires_at, company_id)
     VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)`
  ).run(uuid(), email, tok, req.user.id, nowIso(), expiresAt, company.id);

  const link = `${config.baseUrl}/invite/${tok}`;
  const result = await send(
    req.user,
    { to: email, ...invitationToJoinEmail({ invite: { email, role: 'admin', company_id: company.id }, inviter: req.user, link, expiresAt }) },
    { companyId: company.id }
  );
  // Recorded in both logs: the platform's, and the company's own, so its
  // administrators can see how their first account came to exist.
  adminLog({ actor: req.user, action: 'Administrator invited', subject: email, detail: company.name, req, companyId: null });
  adminLog({ actor: req.user, action: 'Invitation sent', subject: email, detail: 'As admin, by the platform owner', req, companyId: company.id });
  return { result, link };
}

/* ------------------------------------------------------------------ list */

router.get('/platform', (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const companies = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.status = 'active') AS users,
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id AND d.status != 'template') AS documents,
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id AND d.status != 'template' AND d.sent_at >= ?) AS sent30,
              (SELECT COUNT(*) FROM documents d WHERE d.company_id = c.id AND d.status = 'template') AS templates,
              (SELECT MAX(last_seen_at) FROM users u WHERE u.company_id = c.id) AS last_active,
              (SELECT group_concat(email, ', ') FROM users u WHERE u.company_id = c.id AND u.role = 'admin' AND u.status = 'active') AS admins,
              (SELECT COUNT(*) FROM invitations i WHERE i.company_id = c.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?) AS pending
       FROM companies c
       ORDER BY c.status = 'active' DESC, c.name COLLATE NOCASE`
    )
    .all(since, nowIso());

  const owners = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, u.status, u.last_seen_at, c.name AS company_name
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
       WHERE u.platform_admin = 1
       ORDER BY u.status = 'active' DESC, u.display_name COLLATE NOCASE`
    )
    .all();
  const ownerInvites = db
    .prepare(
      `SELECT * FROM invitations
       WHERE role = 'platform' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .all(nowIso());

  res.render('platform', {
    owners,
    ownerInvites,
    baseUrl: config.baseUrl,
    companies,
    events: db.prepare('SELECT * FROM admin_events WHERE company_id IS NULL ORDER BY id DESC LIMIT 30').all(),
    platformMail: !!platformSettings()?.smtp_host,
    values: {},
  });
});

/* ---------------------------------------------------------------- create */

router.post('/platform/companies', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.admin_email || '').trim().toLowerCase();

  if (!name) return back(req, res, '/platform', 'error', 'Give the company a name.');
  if (!EMAIL.test(email)) return back(req, res, '/platform', 'error', 'Enter a valid email for its first administrator.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return back(req, res, '/platform', 'error', `${email} already has an account. Each email belongs to one company.`);
  }
  if (db.prepare('SELECT 1 FROM companies WHERE name = ? COLLATE NOCASE').get(name)) {
    return back(req, res, '/platform', 'error', `There is already a company called “${name}”.`);
  }

  const id = uuid();
  db.prepare(`INSERT INTO companies (id, name, status, created_at, created_by) VALUES (?, ?, 'active', ?, ?)`)
    .run(id, name, nowIso(), req.user.id);
  adminLog({ actor: req.user, action: 'Company created', subject: name, req, companyId: null });

  const { result, link } = await inviteAdmin(req, companyById(id), email);
  back(
    req, res, `/platform/companies/${id}`,
    result.delivered ? 'ok' : 'error',
    result.delivered
      ? `${name} created. An invitation has gone to ${email}.`
      : `${name} created, but the invitation email did not send — ${result.reason}. Send them this link yourself: ${link}`
  );
});

/* ---------------------------------------------------------------- detail */

router.get('/platform/companies/:id', loadCompany, (req, res) => {
  const c = req.target;
  const users = db
    .prepare(
      `SELECT u.id, u.display_name, u.email, u.role, u.status, u.last_seen_at, u.created_at, u.platform_admin,
              (SELECT COUNT(*) FROM documents d WHERE d.owner_id = u.id AND d.status != 'template') AS document_count
       FROM users u WHERE u.company_id = ?
       ORDER BY u.role = 'admin' DESC, u.status = 'active' DESC, u.display_name COLLATE NOCASE`
    )
    .all(c.id);
  const invites = db
    .prepare(
      `SELECT * FROM invitations
       WHERE company_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`
    )
    .all(c.id, nowIso());
  const counts = db
    .prepare(
      `SELECT
         SUM(status = 'draft') AS draft, SUM(status = 'sent') AS sent,
         SUM(status = 'completed') AS completed, SUM(status = 'declined') AS declined,
         SUM(status = 'template') AS templates
       FROM documents WHERE company_id = ?`
    )
    .get(c.id);

  res.render('platform-company', {
    c,
    users,
    invites,
    counts,
    events: db.prepare('SELECT * FROM admin_events WHERE company_id = ? ORDER BY id DESC LIMIT 40').all(c.id),
    footprint: companyFootprint(c.id),
    supportMinutes: SUPPORT_MINUTES,
    mailSource: c.smtp_host ? 'own' : mailConfigured(c.id) ? 'platform' : 'none',
    baseUrl: config.baseUrl,
  });
});

router.post('/platform/companies/:id/rename', loadCompany, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  const to = `/platform/companies/${req.target.id}`;
  if (!name) return back(req, res, to, 'error', 'The name cannot be empty.');
  if (db.prepare('SELECT 1 FROM companies WHERE name = ? COLLATE NOCASE AND id != ?').get(name, req.target.id)) {
    return back(req, res, to, 'error', `There is already a company called “${name}”.`);
  }
  db.prepare('UPDATE companies SET name = ? WHERE id = ?').run(name, req.target.id);
  adminLog({ actor: req.user, action: 'Company renamed', subject: name, detail: `Was ${req.target.name}`, req, companyId: null });
  adminLog({ actor: req.user, action: 'Organisation renamed', subject: name, detail: 'By the platform owner', req, companyId: req.target.id });
  back(req, res, to, 'ok', `Renamed to ${name}.`);
});

router.post('/platform/companies/:id/status', loadCompany, (req, res) => {
  const suspend = req.body.status === 'suspended';
  const c = req.target;
  const to = `/platform/companies/${c.id}`;
  if ((c.status === 'suspended') === suspend) return back(req, res, to, 'ok', 'No change.');

  db.prepare('UPDATE companies SET status = ?, suspended_at = ? WHERE id = ?')
    .run(suspend ? 'suspended' : 'active', suspend ? nowIso() : null, c.id);
  const action = suspend ? 'Company suspended' : 'Company reactivated';
  adminLog({ actor: req.user, action, subject: c.name, req, companyId: null });
  adminLog({ actor: req.user, action: suspend ? 'Organisation suspended' : 'Organisation reactivated', detail: 'By the platform owner', req, companyId: c.id });
  back(
    req, res, to, 'ok',
    suspend
      ? `${c.name} is suspended. Its people are signed out and cannot sign in; signing links already sent keep working.`
      : `${c.name} is active again.`
  );
});

/**
 * What deleting a company would take with it — shown on the confirmation and
 * recorded in the platform log afterwards, when the rows themselves are gone.
 */
function companyFootprint(companyId) {
  const one = (sql) => db.prepare(sql).get(companyId).n;
  return {
    users: one('SELECT COUNT(*) AS n FROM users WHERE company_id = ?'),
    documents: one(`SELECT COUNT(*) AS n FROM documents WHERE company_id = ? AND status != 'template'`),
    templates: one(`SELECT COUNT(*) AS n FROM documents WHERE company_id = ? AND status = 'template'`),
    owners: one('SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND platform_admin = 1'),
  };
}

/**
 * Permanently removes a company and everything it owns: its people, their
 * documents and templates with every recipient, field and audit trail, its
 * invitations and administration log, and the PDFs and attachments on disk.
 *
 * Two deliberate steps stand in front of it. The company must already be
 * suspended — so its people have been signed out and nobody is halfway through
 * sending — and the platform owner must type its name, because there is no
 * undo. A company holding a platform owner's account cannot be deleted at all,
 * or the platform could delete its own last way in.
 *
 * Its sealed documents stop verifying afterwards: the record they are checked
 * against is gone. That is the point of deleting, and the page says so.
 */
router.post('/platform/companies/:id/delete', loadCompany, (req, res) => {
  const c = req.target;
  const to = `/platform/companies/${c.id}`;
  const footprint = companyFootprint(c.id);

  if (footprint.owners) {
    return back(req, res, to, 'error', `${c.name} holds a platform owner's account, so it cannot be deleted.`);
  }
  if (c.status !== 'suspended') {
    return back(req, res, to, 'error', `Suspend ${c.name} before deleting it.`);
  }
  if (String(req.body.confirm_name || '').trim() !== c.name) {
    return back(req, res, to, 'error', `Type the company's name exactly — “${c.name}” — to confirm.`);
  }

  // Collected before the rows go, because the rows are what say where they are.
  const files = [
    ...db.prepare('SELECT original_path AS p FROM documents WHERE company_id = ?').all(c.id),
    ...db.prepare('SELECT sealed_path AS p FROM documents WHERE company_id = ? AND sealed_path IS NOT NULL').all(c.id),
    ...db.prepare(
      `SELECT a.path AS p FROM attachments a JOIN documents d ON d.id = a.document_id WHERE d.company_id = ?`
    ).all(c.id),
    { p: c.logo_path },
  ].map((r) => r.p).filter(Boolean);

  db.transaction(() => {
    // Documents first (recipients, fields, attachments and audit events
    // cascade), then people — whose own cascade would catch any document
    // still pointing at them — then everything else the company owned.
    db.prepare('DELETE FROM documents WHERE company_id = ?').run(c.id);
    db.prepare('DELETE FROM users WHERE company_id = ?').run(c.id);
    db.prepare('DELETE FROM invitations WHERE company_id = ?').run(c.id);
    db.prepare('DELETE FROM admin_events WHERE company_id = ?').run(c.id);
    db.prepare('DELETE FROM companies WHERE id = ?').run(c.id);
  })();

  // Files go only once the records are gone for certain. A file that fails to
  // delete is an orphan on disk, which is recoverable; deleting files and then
  // failing the transaction would leave records pointing at nothing.
  let missed = 0;
  for (const p of files) {
    try { fs.rmSync(p, { force: true }); } catch { missed++; }
  }

  adminLog({
    actor: req.user,
    action: 'Company deleted',
    subject: c.name,
    detail: `${footprint.users} account(s), ${footprint.documents} document(s), ${footprint.templates} template(s), ${files.length - missed} file(s) removed` +
      (missed ? `; ${missed} file(s) could not be removed from disk` : ''),
    req,
    companyId: null,
  });
  back(req, res, '/platform', 'ok', `${c.name} and everything it held have been permanently deleted.`);
});

/**
 * Starts a support session as one of the company's people. The reason is
 * required because it is what the company reads in its own log afterwards.
 * Never as another platform owner — that would hand one owner another's reach
 * — and never into a suspended company, whose people cannot sign in either.
 */
router.post('/platform/companies/:id/support', loadCompany, (req, res) => {
  const c = req.target;
  const to = `/platform/companies/${c.id}`;
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  const target = db
    .prepare('SELECT * FROM users WHERE id = ? AND company_id = ?')
    .get(String(req.body.user_id || ''), c.id);

  if (!target) return back(req, res, to, 'error', 'Choose someone at this company to sign in as.');
  if (!reason) return back(req, res, to, 'error', 'Give a reason. It is recorded in the company’s own log, where they can read it.');
  if (c.status !== 'active') return back(req, res, to, 'error', `Reactivate ${c.name} before entering it.`);
  if (target.status !== 'active') return back(req, res, to, 'error', `${target.display_name}'s account is deactivated.`);
  if (target.platform_admin) return back(req, res, to, 'error', 'A platform owner cannot be impersonated.');

  startSupport(req, { platformUser: req.user, target, company: c, reason });
  req.session.flash = {
    type: 'ok',
    text: `You are now signed in as ${target.display_name} at ${c.name} for up to ${SUPPORT_MINUTES} minutes. Everything you do is recorded as platform support.`,
  };
  res.redirect('/dashboard');
});

// The same upload a company administrator makes in Settings, made on their
// behalf — usually while setting a new company up.
router.post('/platform/companies/:id/logo', loadCompany, logoHandler({
  companyIdOf: (req) => req.target.id,
  backTo: (req) => `/platform/companies/${req.target.id}`,
  actorDetail: 'By the platform owner',
}));

router.post('/platform/companies/:id/logo/remove', loadCompany, (req, res) => {
  removeCompanyLogo(req.target.id);
  adminLog({ actor: req.user, action: 'Logo removed', detail: 'By the platform owner', req, companyId: req.target.id });
  back(req, res, `/platform/companies/${req.target.id}`, 'ok', 'Logo removed.');
});

router.post('/platform/companies/:id/invite', loadCompany, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const to = `/platform/companies/${req.target.id}`;
  if (!EMAIL.test(email)) return back(req, res, to, 'error', 'Enter a valid email address.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return back(req, res, to, 'error', `${email} already has an account. Each email belongs to one company.`);
  }
  const { result, link } = await inviteAdmin(req, req.target, email);
  back(
    req, res, to,
    result.delivered ? 'ok' : 'error',
    result.delivered
      ? `Administrator invitation sent to ${email}.`
      : `Invitation created, but the email did not send — ${result.reason}. Send them this link yourself: ${link}`
  );
});

/* ------------------------------------------------------- platform owners */

/**
 * Platform owners are invited like anyone else, but into no company: running
 * the platform is a different job from belonging to one of its clients, and a
 * client should never find the operator on its own team page.
 *
 * Two guards keep the platform from being locked out of itself: an owner
 * cannot remove their own access, and the last active owner cannot be
 * removed by anyone.
 */
const activeOwners = () =>
  db.prepare(`SELECT COUNT(*) AS n FROM users WHERE platform_admin = 1 AND status = 'active'`).get().n;

function loadOwner(req, res, next) {
  const owner = db.prepare('SELECT * FROM users WHERE id = ? AND platform_admin = 1').get(req.params.id);
  if (!owner) return back(req, res, '/platform', 'error', 'That platform owner no longer exists.');
  req.owner = owner;
  next();
}

router.post('/platform/owners/invite', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL.test(email)) return back(req, res, '/platform', 'error', 'Enter a valid email address.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return back(req, res, '/platform', 'error', `${email} already has an account. Each email belongs to one account.`);
  }

  db.prepare(
    `UPDATE invitations SET revoked_at = ? WHERE email = ? AND role = 'platform' AND accepted_at IS NULL AND revoked_at IS NULL`
  ).run(nowIso(), email);
  const tok = token();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  db.prepare(
    `INSERT INTO invitations (id, email, role, token, invited_by, created_at, expires_at, company_id)
     VALUES (?, ?, 'platform', ?, ?, ?, ?, NULL)`
  ).run(uuid(), email, tok, req.user.id, nowIso(), expiresAt);

  const link = `${config.baseUrl}/invite/${tok}`;
  const result = await send(
    req.user,
    { to: email, ...invitationToJoinEmail({ invite: { email, role: 'platform', company_id: null }, inviter: req.user, link, expiresAt }) },
    { companyId: null }
  );
  adminLog({ actor: req.user, action: 'Platform owner invited', subject: email, req, companyId: null });
  back(
    req, res, '/platform',
    result.delivered ? 'ok' : 'error',
    result.delivered
      ? `Platform owner invitation sent to ${email}.`
      : `Invitation created, but the email did not send — ${result.reason}. Send them this link yourself: ${link}`
  );
});

router.post('/platform/owners/invites/:id/revoke', (req, res) => {
  const invite = db.prepare(`SELECT * FROM invitations WHERE id = ? AND role = 'platform' AND accepted_at IS NULL`).get(req.params.id);
  if (invite && !invite.revoked_at) {
    db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(nowIso(), invite.id);
    adminLog({ actor: req.user, action: 'Platform owner invitation withdrawn', subject: invite.email, req, companyId: null });
  }
  back(req, res, '/platform', 'ok', 'Invitation withdrawn.');
});

/**
 * Removes someone's platform access. An owner who also belongs to a company
 * keeps that company role and simply loses the flag; one with no company has
 * nothing else to be, so the account is deactivated instead (and can be
 * restored). Either way, a support session they had open ends with it.
 */
router.post('/platform/owners/:id/remove', loadOwner, (req, res) => {
  const o = req.owner;
  if (o.id === req.user.id) {
    return back(req, res, '/platform', 'error', 'You cannot remove your own platform access. Ask another platform owner.');
  }
  if (o.status === 'active' && activeOwners() <= 1) {
    return back(req, res, '/platform', 'error', 'That is the only active platform owner. Invite another first.');
  }

  if (o.company_id) {
    db.prepare('UPDATE users SET platform_admin = 0 WHERE id = ?').run(o.id);
    const company = companyById(o.company_id);
    adminLog({ actor: req.user, action: 'Platform access removed', subject: o.email, detail: `Remains in ${company?.name || 'their company'} as ${o.role}`, req, companyId: null });
    return back(req, res, '/platform', 'ok', `${o.display_name} is no longer a platform owner. They keep their place at ${company?.name || 'their company'}.`);
  }

  db.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).run(o.id);
  adminLog({ actor: req.user, action: 'Platform owner deactivated', subject: o.email, req, companyId: null });
  back(req, res, '/platform', 'ok', `${o.display_name} has been deactivated and can no longer sign in.`);
});

router.post('/platform/owners/:id/restore', loadOwner, (req, res) => {
  db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(req.owner.id);
  adminLog({ actor: req.user, action: 'Platform owner restored', subject: req.owner.email, req, companyId: null });
  back(req, res, '/platform', 'ok', `${req.owner.display_name} can sign in again.`);
});

/* ------------------------------------------------------------------ mail */

function renderMail(req, res, { saved = false, test = null, error = null } = {}) {
  res.render('platform-mail', { s: platformSettings(), saved, test, error });
}

router.get('/platform/mail', (req, res) => renderMail(req, res, { saved: req.query.saved === '1' }));

router.post('/platform/mail', (req, res) => {
  savePlatformMail(req.body, req.user);
  adminLog({ actor: req.user, action: 'Platform mail changed', detail: String(req.body.smtp_host || '').trim() || 'cleared', req, companyId: null });
  res.redirect('/platform/mail?saved=1');
});

router.post('/platform/mail/test', async (req, res) => {
  // Tested as the platform default specifically — not through the platform
  // owner's own company, which may have its own server.
  const viaPlatform = { companyId: null };
  try {
    await verifySmtp(null);
    const result = await send(req.user, { to: req.user.email, ...smtpTestEmail({ user: req.user, companyId: null }) }, viaPlatform);
    adminLog({ actor: req.user, action: 'Platform mail test', detail: result.delivered ? `Delivered to ${req.user.email}` : result.reason, req, companyId: null });
    renderMail(req, res, result.delivered ? { test: `Test message sent to ${req.user.email}.` } : { error: result.reason });
  } catch (err) {
    renderMail(req, res, { error: err.message });
  }
});

export default router;
