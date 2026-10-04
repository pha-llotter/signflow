import { Router } from 'express';
import path from 'node:path';
import { adminLog } from '../db.js';
import { requireAdmin } from '../middleware/auth.js';
import { verifySmtp, send, smtpTestEmail } from '../mailer.js';
import { companyById, mailSettings, platformSettings, saveCompanySettings } from '../settings-store.js';
import { logoUpload, readLogo, saveCompanyLogo, removeCompanyLogo, LOGO_MAX_BYTES } from '../company-logo.js';

const router = Router();

const MAIL_KEYS = ['smtp_host', 'smtp_port', 'smtp_user', 'from_email', 'from_name'];

/**
 * The organisation's settings. Admin-only — these apply to everyone in the
 * company, so a member changing them would silently reconfigure mail for all
 * of their colleagues.
 */
function render(req, res, { saved = false, test = null, error = null } = {}) {
  res.render('settings', {
    settings: companyById(req.user.company_id),
    effective: mailSettings(req.user.company_id),
    platformMail: !!platformSettings()?.smtp_host,
    saved, test, error,
  });
}

router.get('/settings', requireAdmin, (req, res) => render(req, res, { saved: req.query.saved === '1' }));

router.post('/settings', requireAdmin, (req, res) => {
  const before = companyById(req.user.company_id);
  saveCompanySettings(req.user.company_id, req.body, req.user);
  const after = companyById(req.user.company_id);

  const changed = ['name', ...MAIL_KEYS].filter((k) => before[k] !== after[k]);
  if (req.body.mail_source === 'own' && req.body.smtp_pass) changed.push('smtp password');

  adminLog({
    actor: req.user,
    action: 'Organisation settings changed',
    detail: changed.length ? changed.join(', ') : 'no effective change',
    req,
  });

  res.redirect('/settings?saved=1');
});

router.post('/settings/test', requireAdmin, async (req, res) => {
  try {
    await verifySmtp(req.user.company_id);
    const result = await send(req.user, { to: req.user.email, ...smtpTestEmail({ user: req.user }) });
    adminLog({
      actor: req.user,
      action: 'Mail test sent',
      detail: result.delivered ? `Delivered to ${req.user.email}` : result.reason,
      req,
    });
    render(req, res, result.delivered ? { test: `Test message sent to ${req.user.email}.` } : { error: result.reason });
  } catch (err) {
    render(req, res, { error: err.message });
  }
});

/* ------------------------------------------------------------------ logo */

/**
 * Receives a logo for a company and reports back where the form was. Shared
 * with the platform pages, which upload on a company's behalf.
 */
export function logoHandler({ companyIdOf, backTo, actorDetail = null }) {
  return (req, res) => {
    logoUpload.single('logo')(req, res, async (err) => {
      const companyId = companyIdOf(req);
      const done = (type, text) => {
        req.session.flash = { type, text };
        res.redirect(backTo(req));
      };
      if (err) {
        return done('error', err.code === 'LIMIT_FILE_SIZE'
          ? `The logo must be under ${LOGO_MAX_BYTES / 1024 / 1024} MB — smaller is better, it goes into every certificate.`
          : err.message);
      }
      try {
        const logo = await readLogo(req.file);
        saveCompanyLogo(companyId, logo);
        adminLog({ actor: req.user, action: 'Logo changed', detail: [`${logo.width}×${logo.height} ${logo.ext.toUpperCase()}`, actorDetail].filter(Boolean).join(' · '), req, companyId });
        done('ok', 'Logo saved. It appears on certificates sealed from now on, in emails and in the sidebar.');
      } catch (e) {
        done('error', e.message);
      }
    });
  };
}

router.post('/settings/logo', requireAdmin, logoHandler({
  companyIdOf: (req) => req.user.company_id,
  backTo: () => '/settings',
}));

router.post('/settings/logo/remove', requireAdmin, (req, res) => {
  removeCompanyLogo(req.user.company_id);
  adminLog({ actor: req.user, action: 'Logo removed', req });
  req.session.flash = { type: 'ok', text: 'Logo removed. Certificates already sealed keep the logo they were sealed with.' };
  res.redirect('/settings');
});

/**
 * The image itself, for the sidebar and the settings pages. Not public: only
 * the company's own people (support sessions included) and platform owners.
 * Emails and certificates carry their own copy and never link here.
 */
router.get('/company-logo/:id', (req, res) => {
  const ok = req.user && (req.user.company_id === req.params.id || req.user.platform_admin);
  const c = ok ? companyById(req.params.id) : null;
  if (!c?.logo_path) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.resolve(c.logo_path), (e) => { if (e && !res.headersSent) res.status(404).end(); });
});

export default router;
