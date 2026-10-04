import { Router } from 'express';
import { config } from '../config.js';
import { db, nowIso, adminLog } from '../db.js';
import { requireAdmin, wouldOrphanInstallation } from '../middleware/auth.js';
import { token, uuid } from '../crypto.js';
import { send, invitationToJoinEmail, passwordResetEmail } from '../mailer.js';
import { mailConfigured } from '../settings-store.js';

const router = Router();

const INVITE_DAYS = 7;
const RESET_HOURS = 24;

router.get('/team', requireAdmin, (req, res) => {
  const users = db
    .prepare(
      `SELECT u.*,
              (SELECT COUNT(*) FROM documents d WHERE d.owner_id = u.id AND d.status != 'template') AS document_count
       FROM users u
       ORDER BY u.role = 'admin' DESC, u.status = 'active' DESC, u.display_name COLLATE NOCASE`
    )
    .all();

  const invites = db
    .prepare(
      `SELECT i.*, u.display_name AS inviter
       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
       ORDER BY i.created_at DESC`
    )
    .all(nowIso());

  const events = db.prepare('SELECT * FROM admin_events ORDER BY id DESC LIMIT 40').all();

  res.render('team', {
    users,
    invites,
    events,
    mailReady: mailConfigured(),
    baseUrl: config.baseUrl,
    activeAdmins: users.filter((u) => u.role === 'admin' && u.status === 'active').length,
  });
});

router.post('/team/invite', requireAdmin, async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'admin' ? 'admin' : 'member';

  const back = (type, text) => {
    req.session.flash = { type, text };
    res.redirect('/team');
  };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('error', 'Enter a valid email address.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return back('error', `${email} already has an account.`);
  }

  // Re-inviting should replace the outstanding invitation rather than leave two
  // live links for the same person.
  db.prepare(
    `UPDATE invitations SET revoked_at = ? WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL`
  ).run(nowIso(), email);

  const id = uuid();
  const tok = token();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();

  db.prepare(
    `INSERT INTO invitations (id, email, role, token, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, email, role, tok, req.user.id, nowIso(), expiresAt);

  adminLog({ actor: req.user, action: 'Invitation sent', subject: email, detail: `As ${role}`, req });

  const link = `${config.baseUrl}/invite/${tok}`;
  const result = await send(req.user, {
    to: email,
    ...invitationToJoinEmail({ invite: { email, role }, inviter: req.user, link, expiresAt }),
  });

  back(
    result.delivered ? 'ok' : 'error',
    result.delivered
      ? `Invitation sent to ${email}.`
      : `Invitation created, but the email did not send — ${result.reason}. Copy the link below and send it yourself.`
  );
});

router.post('/team/invite/:id/resend', requireAdmin, async (req, res) => {
  const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.id);
  if (!invite || invite.accepted_at || invite.revoked_at) {
    req.session.flash = { type: 'error', text: 'That invitation is no longer outstanding.' };
    return res.redirect('/team');
  }

  // Resending extends the window; an invitation that expired while someone was
  // on leave should not need to be recreated from scratch.
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 864e5).toISOString();
  db.prepare('UPDATE invitations SET expires_at = ? WHERE id = ?').run(expiresAt, invite.id);

  const link = `${config.baseUrl}/invite/${invite.token}`;
  const result = await send(req.user, {
    to: invite.email,
    ...invitationToJoinEmail({ invite, inviter: req.user, link, expiresAt }),
  });

  adminLog({ actor: req.user, action: 'Invitation resent', subject: invite.email, req });
  req.session.flash = result.delivered
    ? { type: 'ok', text: `Invitation resent to ${invite.email}.` }
    : { type: 'error', text: `Could not send — ${result.reason}.` };
  res.redirect('/team');
});

router.post('/team/invite/:id/revoke', requireAdmin, (req, res) => {
  const invite = db.prepare('SELECT * FROM invitations WHERE id = ?').get(req.params.id);
  if (invite && !invite.accepted_at) {
    db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ?').run(nowIso(), invite.id);
    adminLog({ actor: req.user, action: 'Invitation withdrawn', subject: invite.email, req });
    req.session.flash = { type: 'ok', text: `Invitation to ${invite.email} withdrawn.` };
  }
  res.redirect('/team');
});

/* --------------------------------------------------------------- people */

function loadTarget(req, res, next) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) {
    req.session.flash = { type: 'error', text: 'That account no longer exists.' };
    return res.redirect('/team');
  }
  req.target = target;
  next();
}

router.post('/team/user/:id/role', requireAdmin, loadTarget, (req, res) => {
  const newRole = req.body.role === 'admin' ? 'admin' : 'member';
  const back = (type, text) => {
    req.session.flash = { type, text };
    res.redirect('/team');
  };

  if (req.target.role === newRole) return back('ok', 'No change.');
  if (wouldOrphanInstallation(req.target, { newRole })) {
    return back('error', 'That is the only administrator. Promote someone else first, or nobody can manage the installation.');
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, req.target.id);
  adminLog({
    actor: req.user,
    action: newRole === 'admin' ? 'Promoted to administrator' : 'Changed to member',
    subject: req.target.email,
    req,
  });
  back('ok', `${req.target.display_name} is now ${newRole === 'admin' ? 'an administrator' : 'a member'}.`);
});

router.post('/team/user/:id/status', requireAdmin, loadTarget, (req, res) => {
  const newStatus = req.body.status === 'active' ? 'active' : 'suspended';
  const back = (type, text) => {
    req.session.flash = { type, text };
    res.redirect('/team');
  };

  if (req.target.id === req.user.id && newStatus !== 'active') {
    return back('error', 'You cannot deactivate your own account.');
  }
  if (wouldOrphanInstallation(req.target, { newStatus })) {
    return back('error', 'That is the only administrator. Promote someone else first.');
  }

  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, req.target.id);
  adminLog({
    actor: req.user,
    action: newStatus === 'active' ? 'Account restored' : 'Account deactivated',
    subject: req.target.email,
    detail: newStatus === 'active' ? null : 'Their documents and audit trail are untouched',
    req,
  });
  back(
    'ok',
    newStatus === 'active'
      ? `${req.target.display_name} can sign in again.`
      : `${req.target.display_name} has been deactivated. Their documents and audit trail are untouched.`
  );
});

router.post('/team/user/:id/reset', requireAdmin, loadTarget, async (req, res) => {
  // Closing public sign-up also closes the only route a member had to recover
  // an account, so the admin has to be able to hand out a reset link.
  const tok = token();
  const expiresAt = new Date(Date.now() + RESET_HOURS * 3600e3).toISOString();

  db.prepare(
    `INSERT INTO password_resets (id, user_id, token, issued_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), req.target.id, tok, req.user.id, nowIso(), expiresAt);

  adminLog({ actor: req.user, action: 'Password reset issued', subject: req.target.email, req });

  const link = `${config.baseUrl}/reset/${tok}`;
  const result = await send(req.user, {
    to: req.target.email,
    ...passwordResetEmail({ user: req.target, issuer: req.user, link, expiresAt }),
  });

  req.session.flash = result.delivered
    ? { type: 'ok', text: `A password link has been emailed to ${req.target.email}. It expires in ${RESET_HOURS} hours.` }
    : { type: 'error', text: `Link created but not emailed — ${result.reason}. Send it to them directly: ${link}` };
  res.redirect('/team');
});

export default router;
