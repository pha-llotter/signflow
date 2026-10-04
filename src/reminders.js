import { db } from './db.js';
import { inviteRecipient } from './routes/documents.js';

/**
 * Automatic reminders. Each document carries reminder_days — 0 for off — and
 * while it is out for signature, anyone who has not signed is sent their
 * signing link again every that many days, counted from when it was sent or
 * last chased.
 *
 * Stops on its own: a completed, declined, expired or trashed document is
 * never selected, nor is one whose sender has been deactivated or whose
 * company is suspended. With signing order on, only the person whose turn it
 * is gets chased — the rest have not been invited yet.
 */
export const REMINDER_CHOICES = [
  [0, 'Off'],
  [1, 'Every day'],
  [2, 'Every 2 days'],
  [3, 'Every 3 days'],
  [7, 'Every week'],
];
export const DEFAULT_REMINDER_DAYS = 3;

/** Whatever the form sent, one of the offered intervals. */
export function readReminderDays(value) {
  if (value === undefined || value === '') return DEFAULT_REMINDER_DAYS;
  const n = Number(value);
  return REMINDER_CHOICES.some(([d]) => d === n) ? n : DEFAULT_REMINDER_DAYS;
}

/**
 * A reminder interval has to be shorter than the time allowed to sign, or the
 * first reminder would land after the link has already stopped working —
 * "every 3 days" on a document that expires tomorrow. Too long an interval
 * becomes the longest one that still fits, or off when none does.
 */
export function fitReminderDays(days, expiryDays) {
  if (!days || !Number.isFinite(expiryDays) || days < expiryDays) return days;
  const fits = REMINDER_CHOICES.map(([d]) => d).filter((d) => d > 0 && d < expiryDays);
  return fits.length ? Math.max(...fits) : 0;
}

const DAY = 24 * 60 * 60 * 1000;

/** The days a document allows for signing, from when it went out (or was made) to its expiry. */
export function expiryDaysOf(doc) {
  if (!doc.expires_at) return Infinity;
  return (Date.parse(doc.expires_at) - Date.parse(doc.sent_at || doc.created_at)) / DAY;
}

export async function sendDueReminders(now = Date.now()) {
  const docs = db
    .prepare(
      `SELECT d.* FROM documents d
       JOIN users u ON u.id = d.owner_id
       LEFT JOIN companies c ON c.id = d.company_id
       WHERE d.status = 'sent' AND d.deleted_at IS NULL AND d.reminder_days > 0
         AND u.status = 'active' AND (c.id IS NULL OR c.status = 'active')
         AND (d.expires_at IS NULL OR d.expires_at > ?)`
    )
    .all(new Date(now).toISOString());

  let sent = 0;
  for (const doc of docs) {
    const since = Date.parse(doc.last_reminded_at || doc.sent_at);
    if (!Number.isFinite(since) || now - since < doc.reminder_days * DAY) continue;

    // Claimed before any mail goes out — and only if nothing has changed since
    // this sweep read the row. The read and the sends are separated by mail
    // round trips, so another sweep, or the sender turning reminders off, may
    // have got there first; the conditional update makes exactly one claim win.
    const claimed = db
      .prepare(
        `UPDATE documents SET last_reminded_at = ?
         WHERE id = ? AND status = 'sent' AND deleted_at IS NULL AND reminder_days > 0
           AND COALESCE(last_reminded_at, sent_at) = ?`
      )
      .run(new Date(now).toISOString(), doc.id, doc.last_reminded_at || doc.sent_at).changes;
    if (!claimed) continue;

    const pending = db
      .prepare(
        `SELECT * FROM recipients
         WHERE document_id = ? AND status IN ('pending', 'viewed') AND token IS NOT NULL
         ORDER BY order_index`
      )
      .all(doc.id);
    const due = doc.signing_order ? pending.slice(0, 1) : pending;
    const sender = db
      .prepare('SELECT u.*, c.name AS org_name FROM users u LEFT JOIN companies c ON c.id = u.company_id WHERE u.id = ?')
      .get(doc.owner_id);

    for (const r of due) {
      await inviteRecipient({ doc, recipient: r, sender, reminder: true, automatic: true });
      sent++;
    }
  }
  return sent;
}

/**
 * Runs the sweep on a timer. Fifteen minutes by default: reminders are counted
 * in days, so being up to a quarter of an hour late costs nothing.
 * REMINDER_SWEEP_MS shortens it for the test suites.
 */
export function startReminderSweeps() {
  const every = Number(process.env.REMINDER_SWEEP_MS) || 15 * 60 * 1000;
  // One sweep at a time: a slow mail server must not let the next tick start
  // a second pass over the same documents.
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDueReminders();
    } catch (err) {
      console.error(`[reminders] ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, every);
  timer.unref?.();
  return timer;
}
