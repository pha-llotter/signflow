import { Router } from 'express';
import { db, adminLog } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../crypto.js';

const router = Router();

/**
 * Everything a member can change about themselves. Separate from /settings,
 * which is installation-wide and admin-only — without this, a member would
 * have no way to change their own password at all.
 */
router.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { saved: req.query.saved === '1', error: null, passwordSaved: false });
});

router.post('/profile', requireAuth, (req, res) => {
  const name = String(req.body.display_name || '').trim();
  if (name.length < 2) {
    return res.status(400).render('profile', {
      saved: false, passwordSaved: false, error: 'Enter your name.',
    });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
  res.redirect('/profile?saved=1');
});

router.post('/profile/password', requireAuth, async (req, res) => {
  const current = String(req.body.current_password || '');
  const next = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');

  const fail = (error) =>
    res.status(400).render('profile', { saved: false, passwordSaved: false, error });

  // The current password is required even though the session is already
  // authenticated: it stops an unattended browser being used to take over
  // the account permanently.
  if (!(await verifyPassword(req.user.password_hash, current))) {
    return fail('Your current password is not correct.');
  }
  if (next.length < 10) return fail('Use a new password of at least 10 characters.');
  if (next !== confirm) return fail('The two new passwords do not match.');
  if (next === current) return fail('That is the password you already have.');

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
  adminLog({ actor: req.user, action: 'Password changed', subject: req.user.email, detail: 'By the account holder', req });

  // A password change should not invalidate the session the user is sitting in.
  req.session.regenerate((err) => {
    if (err) return fail('Password changed, but the session could not be renewed. Please sign in again.');
    req.session.userId = req.user.id;
    res.render('profile', { saved: false, passwordSaved: true, error: null });
  });
});

export default router;
