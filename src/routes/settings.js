import { Router } from 'express';
import { adminLog } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { verifySmtp, send, smtpTestEmail } from '../mailer.js';
import { appSettings, saveAppSettings } from '../settings-store.js';

const router = Router();

/**
 * Installation settings. Admin-only — these apply to everyone, so a member
 * changing them would silently reconfigure mail for the whole organisation.
 */
router.get('/settings', requireAdmin, (req, res) => {
  res.render('settings', {
    settings: appSettings(),
    saved: req.query.saved === '1',
    test: null,
    error: null,
  });
});

router.post('/settings', requireAdmin, (req, res) => {
  const before = appSettings();
  saveAppSettings(req.body, req.user);
  const after = appSettings();

  const changed = ['org_name', 'smtp_host', 'smtp_port', 'smtp_user', 'from_email', 'from_name']
    .filter((k) => before[k] !== after[k]);
  if (req.body.smtp_pass) changed.push('smtp password');

  adminLog({
    actor: req.user,
    action: 'Installation settings changed',
    detail: changed.length ? changed.join(', ') : 'no effective change',
    req,
  });

  res.redirect('/settings?saved=1');
});

router.post('/settings/test', requireAdmin, async (req, res) => {
  const render = (test, error) =>
    res.render('settings', { settings: appSettings(), saved: false, test, error });

  try {
    await verifySmtp();
    const result = await send(req.user, { to: req.user.email, ...smtpTestEmail({ user: req.user }) });
    adminLog({
      actor: req.user,
      action: 'Mail test sent',
      detail: result.delivered ? `Delivered to ${req.user.email}` : result.reason,
      req,
    });
    render(result.delivered ? `Test message sent to ${req.user.email}.` : null, result.delivered ? null : result.reason);
  } catch (err) {
    render(null, err.message);
  }
});

export default router;
