import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { mailConfigured } from '../settings-store.js';

const router = Router();

const DAY = 24 * 60 * 60 * 1000;
// How long a sent document may sit unsigned before the dashboard raises it.
const STALE_DAYS = 3;
// A decline stops mattering once it has been dealt with; two weeks is long
// enough to notice it without keeping it on the dashboard for ever.
const DECLINE_DAYS = 14;
const COLUMN_LIMIT = 4;

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function duration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${(ms / DAY).toFixed(1)} days`;
}

router.get('/dashboard', requireAuth, (req, res) => {
  const now = Date.now();

  const docs = db
    .prepare(
      `SELECT d.*,
              (SELECT group_concat(name, ', ') FROM
                 (SELECT name FROM recipients r WHERE r.document_id = d.id ORDER BY r.order_index)) AS recipient_names,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id) AS recipient_count,
              (SELECT COUNT(*) FROM recipients r WHERE r.document_id = d.id AND r.status = 'signed') AS signed_count,
              (SELECT MAX(declined_at) FROM recipients r WHERE r.document_id = d.id) AS declined_at
       FROM documents d WHERE d.owner_id = ? AND d.status != 'template' AND d.deleted_at IS NULL
       ORDER BY COALESCE(d.completed_at, d.sent_at, d.created_at) DESC`
    )
    .all(req.user.id);

  // Documents someone else in this installation sent to the signed-in user.
  // A token only exists once a recipient has actually been invited, so with
  // signing order on this never surfaces a document before it is their turn.
  // Linking straight to the signing page is safe: the account's email is the
  // address the token was sent to, and accounts exist only by invitation.
  // Only the user's own company: a document another company sent to the same
  // address still reached them by email, but its title and sender are that
  // company's to show, not this one's.
  const waitingForMe = db
    .prepare(
      `SELECT d.id, d.title, d.sent_at, r.token, u.display_name AS sender
       FROM recipients r
       JOIN documents d ON d.id = r.document_id
       JOIN users u ON u.id = d.owner_id
       WHERE r.email = ? COLLATE NOCASE
         AND r.status IN ('pending', 'viewed')
         AND r.token IS NOT NULL
         AND d.status = 'sent'
         AND d.deleted_at IS NULL
         AND d.company_id = ?
         AND (d.expires_at IS NULL OR d.expires_at > ?)
       ORDER BY d.sent_at`
    )
    .all(req.user.email, req.user.company_id, new Date(now).toISOString());

  const by = (status) => docs.filter((d) => d.status === status);
  const sent = by('sent');
  const completed = by('completed');
  const declined = by('declined');
  const drafts = by('draft');

  const needs = [
    ...waitingForMe.map((d) => ({
      kind: 'sign',
      title: d.title,
      detail: `${d.sender} asked you to sign this`,
      href: `/sign/${d.token}`,
      cta: 'Sign now',
    })),
    ...declined
      .filter((d) => d.declined_at && now - new Date(d.declined_at) < DECLINE_DAYS * DAY)
      .map((d) => ({
        kind: 'declined',
        title: d.title,
        detail: `Declined ${new Date(d.declined_at).toLocaleDateString()}`,
        href: `/documents/${d.id}`,
        cta: 'Review',
      })),
    ...sent
      .filter((d) => d.sent_at && now - new Date(d.sent_at) > STALE_DAYS * DAY)
      .map((d) => ({
        kind: 'stale',
        id: d.id,
        title: d.title,
        detail: `Sent ${Math.floor((now - new Date(d.sent_at)) / DAY)} days ago · ${d.signed_count} of ${d.recipient_count} signed`,
        href: `/documents/${d.id}`,
      })),
  ];

  const turnaround = completed
    .filter((d) => d.sent_at && d.completed_at)
    .map((d) => new Date(d.completed_at) - new Date(d.sent_at));
  const mid = median(turnaround);
  const closed = completed.length + declined.length + sent.length;
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1);

  const stats = {
    medianToSign: mid === null ? null : duration(mid),
    completedCount: completed.length,
    completionRate: closed ? Math.round((completed.length / closed) * 100) : null,
    closed,
    sentThisMonth: docs.filter((d) => d.sent_at && new Date(d.sent_at) >= monthStart).length,
    awaiting: sent.length,
    signatures: docs.reduce((n, d) => n + d.signed_count, 0),
  };

  const column = (key, title, items, href, empty) => ({
    key, title, href, empty,
    total: items.length,
    items: items.slice(0, COLUMN_LIMIT),
  });

  const columns = [
    column('me', 'Waiting for me',
      waitingForMe.map((d) => ({ title: d.title, sub: `From ${d.sender}`, href: `/sign/${d.token}` })),
      null, 'No documents awaiting you.'),
    column('others', 'Waiting for others',
      sent.map((d) => ({ title: d.title, sub: `${d.signed_count} of ${d.recipient_count} signed`, href: `/documents/${d.id}` })),
      '/documents?status=sent', 'No documents are waiting for others.'),
    column('declined', 'Declined',
      declined.map((d) => ({ title: d.title, sub: `To: ${d.recipient_names || '—'}`, href: `/documents/${d.id}` })),
      '/documents?status=declined', 'No declined documents.'),
    column('completed', 'Completed',
      completed.map((d) => ({ title: d.title, sub: `To: ${d.recipient_names || '—'}`, href: `/documents/${d.id}` })),
      '/documents?status=completed', 'Nothing completed yet.'),
  ];

  res.render('dashboard', {
    firstName: String(req.user.display_name || '').trim().split(/\s+/)[0] || 'there',
    needs,
    staleDays: STALE_DAYS,
    stats,
    columns,
    totals: { drafts: drafts.length, all: docs.length, completed: completed.length },
    mailReady: mailConfigured(req.user.company_id),
  });
});

export default router;
