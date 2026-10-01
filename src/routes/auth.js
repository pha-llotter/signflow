import { Router } from 'express';
import { db, nowIso, adminLog } from '../db.js';
import { hashPassword, verifyPassword, uuid } from '../crypto.js';

const router = Router();

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

/**
 * Public sign-up exists only to create the very first account, which becomes
 * the administrator. After that the installation is invitation-only — an
 * open registration form on a document-signing tool lets anyone give
 * themselves a seat.
 */
const firstRunOnly = (req, res, next) => {
  if (userCount() > 0) {
    req.session.flash = {
      type: 'error',
      text: 'This installation is invitation-only. Ask an administrator to invite you.',
    };
    return res.redirect('/login');
  }
  next();
};

router.get('/register', firstRunOnly, (req, res) => {
  if (req.user) return res.redirect('/documents');
  res.render('register', { values: {}, error: null });
});

router.post('/register', firstRunOnly, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.display_name || '').trim();
  const org = String(req.body.org_name || '').trim();
  const password = String(req.body.password || '');
  const values = { email, display_name: name, org_name: org };

  const fail = (error) => res.status(400).render('register', { values, error });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('Enter a valid email address.');
  if (name.length < 2) return fail('Enter your name.');
  if (password.length < 10) return fail('Use a password of at least 10 characters.');

  const id = uuid();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, org_name, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)`
  ).run(id, email, await hashPassword(password), name, org || null, nowIso());

  // The organisation name given here seeds the installation-wide record, so it
  // appears on emails and the team page without a second trip to Settings.
  if (org) db.prepare('UPDATE app_settings SET org_name = ? WHERE id = 1').run(org);

  adminLog({
    actor: { id, email },
    action: 'Installation created',
    subject: email,
    detail: 'First account — administrator',
    req,
  });

  req.session.regenerate(() => {
    req.session.userId = id;
    res.redirect('/team');
  });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/documents');
  res.render('login', {
    email: '',
    error: req.query.deactivated
      ? 'Your account has been deactivated. Ask an administrator to restore it.'
      : null,
    firstRun: userCount() === 0,
  });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  // Verify against a dummy hash when the account is unknown so a wrong email
  // and a wrong password take the same time to answer.
  const ok = user
    ? await verifyPassword(user.password_hash, password)
    : await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0000000000000000000000000000000000000000000', password);

  const reject = (msg) =>
    res.status(401).render('login', { email, error: msg, firstRun: userCount() === 0 });

  if (!ok || !user) return reject('Email or password is incorrect.');
  // Deliberately distinct from a bad password: the person holds valid
  // credentials and needs to know the account was turned off, not keep retrying.
  if (user.status !== 'active') {
    return reject('That account has been deactivated. Ask an administrator to restore it.');
  }

  req.session.regenerate((err) => {
    if (err) return reject('Could not start a session.');
    req.session.userId = user.id;
    const to = req.session.returnTo || '/documents';
    delete req.session.returnTo;
    res.redirect(to);
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ----------------------------------------------------- accepting an invite */

function loadInvite(req, res, next) {
  const invite = db.prepare('SELECT * FROM invitations WHERE token = ?').get(String(req.params.token || ''));
  const dead = (message) => res.status(410).render('invite-closed', { message });

  if (!invite) return dead('This invitation link is not valid. Ask your administrator to send a new one.');
  if (invite.revoked_at) return dead('This invitation has been withdrawn.');
  if (invite.accepted_at) return dead('This invitation has already been used. Try signing in instead.');
  if (new Date(invite.expires_at) < new Date()) return dead('This invitation has expired. Ask your administrator to send a new one.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(invite.email)) {
    return dead('An account already exists for that address. Try signing in instead.');
  }

  req.invite = invite;
  next();
}

router.get('/invite/:token', loadInvite, (req, res) => {
  res.render('invite', { invite: req.invite, token: req.params.token, error: null, values: {} });
});

router.post('/invite/:token', loadInvite, async (req, res) => {
  const name = String(req.body.display_name || '').trim();
  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');

  const fail = (error) =>
    res.status(400).render('invite', {
      invite: req.invite, token: req.params.token, error, values: { display_name: name },
    });

  if (name.length < 2) return fail('Enter your name.');
  if (password.length < 10) return fail('Use a password of at least 10 characters.');
  if (password !== confirm) return fail('The two passwords do not match.');

  const id = uuid();
  const hash = await hashPassword(password);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO users (id, email, password_hash, display_name, role, status, created_at, invited_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).run(id, req.invite.email, hash, name, req.invite.role, nowIso(), req.invite.invited_by);
    db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(nowIso(), req.invite.id);
  })();

  adminLog({
    actor: { id, email: req.invite.email },
    action: 'Invitation accepted',
    subject: req.invite.email,
    detail: `Joined as ${req.invite.role}`,
    req,
  });

  req.session.regenerate(() => {
    req.session.userId = id;
    res.redirect('/documents');
  });
});

/* ------------------------------------------------------- password reset */

function loadReset(req, res, next) {
  const reset = db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(req.params.token || ''));
  const dead = (message) => res.status(410).render('invite-closed', { message });

  if (!reset) return dead('This password link is not valid. Ask your administrator for a new one.');
  if (reset.used_at) return dead('This password link has already been used.');
  if (new Date(reset.expires_at) < new Date()) return dead('This password link has expired. Ask your administrator for a new one.');

  req.reset = reset;
  req.resetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(reset.user_id);
  if (!req.resetUser) return dead('That account no longer exists.');
  next();
}

router.get('/reset/:token', loadReset, (req, res) => {
  res.render('reset', { user: req.resetUser, token: req.params.token, error: null });
});

router.post('/reset/:token', loadReset, async (req, res) => {
  const password = String(req.body.password || '');
  const confirm = String(req.body.password_confirm || '');

  const fail = (error) =>
    res.status(400).render('reset', { user: req.resetUser, token: req.params.token, error });

  if (password.length < 10) return fail('Use a password of at least 10 characters.');
  if (password !== confirm) return fail('The two passwords do not match.');

  const hash = await hashPassword(password);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.resetUser.id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(nowIso(), req.reset.id);
    // Any other outstanding link for this account is now stale.
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(nowIso(), req.resetUser.id);
  })();

  adminLog({
    actor: { id: req.resetUser.id, email: req.resetUser.email },
    action: 'Password changed',
    subject: req.resetUser.email,
    detail: 'Via reset link',
    req,
  });

  req.session.regenerate(() => {
    req.session.userId = req.resetUser.id;
    req.session.flash = { type: 'ok', text: 'Your new password is set.' };
    res.redirect('/documents');
  });
});

export default router;
