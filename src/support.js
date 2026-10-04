import { adminLog } from './db.js';

/**
 * Platform support sessions: the platform owner acting as someone inside a
 * company, to see what they see and fix what they cannot.
 *
 * The session holds the person being helped as its user and the platform
 * owner as `impersonator`, so every page behaves exactly as it does for them.
 * What keeps that honest:
 *   - it is time-limited, and ends itself when the time is up;
 *   - it starts with a stated reason, recorded in the company's own
 *     administration log as well as the platform's, so a company can always
 *     see that someone came in, when, as whom and why;
 *   - anything done during it is attributed to both people (see audit() and
 *     adminLog() in db.js), including in a document's audit trail and so on
 *     its certificate.
 */
export const SUPPORT_MINUTES = 60;

export function startSupport(req, { platformUser, target, company, reason }) {
  req.session.impersonator = {
    id: platformUser.id,
    email: platformUser.email,
    targetId: target.id,
    targetEmail: target.email,
    companyId: company.id,
    reason,
    startedAt: Date.now(),
    expiresAt: Date.now() + SUPPORT_MINUTES * 60 * 1000,
  };
  req.session.userId = target.id;

  const detail = `Reason: ${reason} · up to ${SUPPORT_MINUTES} minutes`;
  adminLog({ actor: platformUser, action: 'Support session started', subject: target.email, detail, req, companyId: company.id });
  adminLog({ actor: platformUser, action: 'Support session started', subject: `${target.email} (${company.name})`, detail, req, companyId: null });
}

/**
 * Ends the session and puts the platform owner back in their own account.
 * Returns the company that was being helped, so the caller can go back to it.
 * `why` distinguishes leaving from being timed out in the log.
 */
export function endSupport(req, why = 'Ended by the platform owner') {
  const imp = req.session?.impersonator;
  if (!imp) return null;
  const minutes = Math.max(1, Math.round((Date.now() - imp.startedAt) / 60000));
  const actor = { id: imp.id, email: imp.email };
  const detail = `${why} · ${minutes} minute${minutes === 1 ? '' : 's'}`;

  delete req.session.impersonator;
  req.session.userId = imp.id;

  adminLog({ actor, action: 'Support session ended', subject: imp.targetEmail, detail, req, companyId: imp.companyId });
  adminLog({ actor, action: 'Support session ended', subject: imp.targetEmail, detail, req, companyId: null });
  return imp.companyId;
}
