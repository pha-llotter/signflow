import { db, nowIso } from '../db.js';

export function currentUser(req, res, next) {
  req.user = null;
  req.deactivated = false;

  if (req.session?.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    // A deactivated account must lose its live session immediately, not at the
    // next login — otherwise removing someone's access does nothing until they
    // happen to sign out.
    //
    // The identity is dropped but the session object is kept: destroying it
    // here leaves req.session undefined for every middleware that runs after,
    // and the redirect to /login then throws instead of redirecting.
    if (!user || user.status !== 'active') {
      if (user) req.deactivated = true;
      delete req.session.userId;
    } else {
      req.user = user;
      // Cheap enough to write on every request, and it is what tells an admin
      // whether an account is still in use before they deactivate it.
      db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(nowIso(), user.id);
    }
  }
  res.locals.user = req.user;
  res.locals.isAdmin = req.user?.role === 'admin';
  next();
}

/** Sends an unauthenticated request to sign in, saying so if they were cut off. */
function toLogin(req, res) {
  if (req.session) req.session.returnTo = req.originalUrl;
  return res.redirect(req.deactivated ? '/login?deactivated=1' : '/login');
}

export function requireAuth(req, res, next) {
  if (!req.user) return toLogin(req, res);
  next();
}

/** 404 rather than 403: an admin-only route should not confirm it exists. */
export function requireAdmin(req, res, next) {
  if (!req.user) return toLogin(req, res);
  if (req.user.role !== 'admin') {
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

/** A private template is its creator's alone; a team template is everyone's to use. */
export const canUseTemplate = (user, doc) =>
  doc?.status === 'template' && (doc.owner_id === user.id || doc.template_visibility === 'team');

/** Editing is narrower than using: the creator, or an administrator for a team template. */
export const canManageTemplate = (user, doc) =>
  doc?.status === 'template' &&
  (doc.owner_id === user.id || (doc.template_visibility === 'team' && user.role === 'admin'));

/**
 * For the routes the placer shares between drafts and templates: a draft must
 * be the user's own, a template must be one they may manage. 404 otherwise,
 * so a private template's id does not confirm it exists.
 */
export function editableDocument(req, res, next) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  const ok = doc && (doc.status === 'template' ? canManageTemplate(req.user, doc) : doc.owner_id === req.user.id);
  if (!ok) return res.status(404).render('error', { code: 404, message: 'Document not found.' });
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

export const adminCount = () =>
  db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'`).get().n;

/**
 * Guards the two ways an installation can be left with nobody who can
 * administer it: demoting the last admin, or deactivating them. Both are easy
 * to do by accident and impossible to undo from inside the app.
 */
export function wouldOrphanInstallation(targetUser, { newRole, newStatus } = {}) {
  const stillAdmin = (newRole ?? targetUser.role) === 'admin';
  const stillActive = (newStatus ?? targetUser.status) === 'active';
  if (stillAdmin && stillActive) return false;
  if (targetUser.role !== 'admin' || targetUser.status !== 'active') return false;
  return adminCount() <= 1;
}
