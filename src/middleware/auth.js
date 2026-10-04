import { db, nowIso } from '../db.js';
import { endSupport, SUPPORT_MINUTES } from '../support.js';

/**
 * A support session is only as good as the platform owner behind it: one who
 * has lost the flag or been deactivated loses the session with it, and every
 * session ends itself when its time is up. Returns that owner while the
 * session stands, null when there is none (or it has just been ended).
 */
function checkSupport(req) {
  const imp = req.session?.impersonator;
  if (!imp) return null;
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(imp.id);
  if (!owner || !owner.platform_admin || owner.status !== 'active') {
    // Ended, and nobody is signed in: the account it would hand back to is
    // exactly the one that no longer qualifies.
    endSupport(req, 'Ended: the support account is no longer a platform owner');
    delete req.session.userId;
    return null;
  }
  if (Date.now() > imp.expiresAt) {
    endSupport(req, `Ended automatically after ${SUPPORT_MINUTES} minutes`);
    req.supportExpired = true;
    return null;
  }
  return owner;
}

export function currentUser(req, res, next) {
  req.user = null;
  req.company = null;
  req.impersonator = null;
  req.deactivated = false;
  req.companySuspended = false;

  req.impersonator = checkSupport(req);

  if (req.session?.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    const company = user?.company_id
      ? db.prepare('SELECT * FROM companies WHERE id = ?').get(user.company_id)
      : null;
    // Suspending a company signs all of its people out at once. The platform
    // owner is exempt, or suspending their own company would lock them out of
    // the very page that reverses it.
    const suspended = company?.status === 'suspended' && !user.platform_admin;
    // A deactivated account must lose its live session immediately, not at the
    // next login — otherwise removing someone's access does nothing until they
    // happen to sign out.
    //
    // The identity is dropped but the session object is kept: destroying it
    // here leaves req.session undefined for every middleware that runs after,
    // and the redirect to /login then throws instead of redirecting.
    if (req.impersonator && (!user || user.status !== 'active' || suspended)) {
      // The person being helped was deactivated, or their company suspended,
      // mid-session. Support ends and the platform owner is back in their own
      // account rather than signed out.
      endSupport(req, 'Ended: the account or its company is no longer active');
      req.impersonator = null;
      return currentUser(req, res, next);
    }
    if (!user || user.status !== 'active' || suspended) {
      if (user) req.deactivated = true;
      req.companySuspended = suspended;
      delete req.session.userId;
    } else {
      req.user = user;
      req.company = company;
      // Cheap enough to write on every request, and it is what tells an admin
      // whether an account is still in use before they deactivate it. Not
      // during support: the platform owner visiting is not them using it.
      if (!req.impersonator) {
        db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso(), user.id);
      }
    }
  }
  res.locals.user = req.user;
  res.locals.company = req.company;
  res.locals.isAdmin = req.user?.role === 'admin';
  res.locals.isPlatformAdmin = !!req.user?.platform_admin;
  res.locals.support = req.impersonator && req.user
    ? { by: req.impersonator, expiresAt: req.session.impersonator.expiresAt, reason: req.session.impersonator.reason }
    : null;
  if (req.supportExpired) {
    // Picked up by the flash middleware, which runs after this one.
    req.session.flash = { type: 'ok', text: `Your support session ended after ${SUPPORT_MINUTES} minutes. You are back in your own account.` };
  }
  next();
}

/** Sends an unauthenticated request to sign in, saying so if they were cut off. */
/**
 * The placer saves through /api with fetch, which follows a redirect silently
 * and would read the sign-in page that comes back as a successful save. So an
 * API request gets a status and a sentence it can show instead of a redirect.
 */
const isApi = (req) => req.originalUrl.startsWith('/api/');
const apiError = (res, status, error) => res.status(status).json({ error });

function toLogin(req, res) {
  if (isApi(req)) return apiError(res, 401, 'You have been signed out. Sign in again in another tab, then save.');
  if (req.session) req.session.returnTo = req.originalUrl;
  if (req.companySuspended) return res.redirect('/login?suspended=1');
  return res.redirect(req.deactivated ? '/login?deactivated=1' : '/login');
}

/**
 * A platform owner need not belong to any company. Documents, templates, the
 * team and settings all live inside one, so such an account is sent to the
 * platform pages instead — everything but its own profile.
 */
const COMPANYLESS_OK = /^\/(profile|verification)(\/|$)/;
const outsideCompany = (req) => !req.user.company_id && !COMPANYLESS_OK.test(req.path);

export function requireAuth(req, res, next) {
  if (!req.user) return toLogin(req, res);
  if (outsideCompany(req)) {
    if (isApi(req)) {
      return apiError(res, 403, `This browser is now signed in as ${req.user.email}, which is not in a company. Sign in as the document's owner, then reload.`);
    }
    return res.redirect('/platform');
  }
  next();
}

/** 404 rather than 403: an admin-only route should not confirm it exists. */
export function requireAdmin(req, res, next) {
  if (!req.user) return toLogin(req, res);
  if (outsideCompany(req)) return res.redirect('/platform');
  if (req.user.role !== 'admin') {
    return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  }
  next();
}

/**
 * The platform pages: creating and suspending companies. Separate from the
 * per-company administrator role — a school's admin manages their school, not
 * the platform. 404 for anyone else, so the pages do not advertise themselves.
 */
export function requirePlatform(req, res, next) {
  if (!req.user) return toLogin(req, res);
  if (!req.user.platform_admin) {
    return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  }
  next();
}

/**
 * Loads a document and refuses it unless the signed-in user owns it. Templates
 * are stored as documents but are never reachable through the document routes
 * — they have their own, with their own sharing rules.
 */
export function ownedDocument(req, res, next) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc || doc.owner_id !== req.user.id || doc.status === 'template') {
    return res.status(404).render('error', { code: 404, message: 'Document not found.' });
  }
  req.doc = doc;
  next();
}

/** "Team" means the creator's own company — never the whole platform. */
const sameTeam = (user, doc) => doc.template_visibility === 'team' && !!doc.company_id && doc.company_id === user.company_id;

/** A private template is its creator's alone; a team template is their company's to use. */
export const canUseTemplate = (user, doc) =>
  doc?.status === 'template' && (doc.owner_id === user.id || sameTeam(user, doc));

/** Editing is narrower than using: the creator, or their company's administrator for a team template. */
export const canManageTemplate = (user, doc) =>
  doc?.status === 'template' &&
  (doc.owner_id === user.id || (sameTeam(user, doc) && user.role === 'admin'));

/**
 * For the routes the placer shares between drafts and templates: a draft must
 * be the user's own, a template must be one they may manage. 404 otherwise,
 * so a private template's id does not confirm it exists.
 */
export function editableDocument(req, res, next) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  const ok = doc && (doc.status === 'template' ? canManageTemplate(req.user, doc) : doc.owner_id === req.user.id);
  if (!ok) {
    if (isApi(req)) {
      return apiError(res, 404, `${req.user.email} cannot edit this document — this browser may be signed in as a different account. Reload to check.`);
    }
    return res.status(404).render('error', { code: 404, message: 'Document not found.' });
  }
  req.doc = doc;
  next();
}

/** Loads a template the user may at least use. */
export function usableTemplate(req, res, next) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!canUseTemplate(req.user, doc)) {
    return res.status(404).render('error', { code: 404, message: 'Template not found.' });
  }
  req.doc = doc;
  req.canManage = canManageTemplate(req.user, doc);
  next();
}

export const adminCount = (companyId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND company_id = ?`).get(companyId).n;

/**
 * Guards the two ways a company can be left with nobody who can administer
 * it: demoting its last admin, or deactivating them. Both are easy to do by
 * accident and impossible to undo from inside the company.
 */
export function wouldOrphanCompany(targetUser, { newRole, newStatus } = {}) {
  const stillAdmin = (newRole ?? targetUser.role) === 'admin';
  const stillActive = (newStatus ?? targetUser.status) === 'active';
  if (stillAdmin && stillActive) return false;
  if (targetUser.role !== 'admin' || targetUser.status !== 'active') return false;
  return adminCount(targetUser.company_id) <= 1;
}
