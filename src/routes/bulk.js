import { Router } from 'express';
import multer from 'multer';
import { db, nowIso, audit } from '../db.js';
import { requireAuth, usableTemplate } from '../middleware/auth.js';
import { uuid } from '../crypto.js';
import { cloneDocument } from '../clone.js';
import { sendDocument } from './documents.js';
import { parseCsv, toCsv } from '../csv.js';
import { readReminderDays, fitReminderDays, REMINDER_CHOICES, DEFAULT_REMINDER_DAYS } from '../reminders.js';

/**
 * Bulk sending: one template, one uploaded CSV, one document per row.
 *
 * The CSV has a name and an email column for each of the template's roles,
 * plus an optional title. Nothing is sent from the upload itself: it is read,
 * every row is checked, and the person sees what will go out — rows with a
 * problem are listed and skipped, never half-sent. Only then does a batch
 * start, and it runs in the background, because a few hundred invitations
 * through a mail server is minutes of work, not a page load.
 */
const router = Router();

const MAX_ROWS = 500;
const MAX_BYTES = 1024 * 1024;
// A checked upload waits this long for its Send before it must be uploaded again.
const STASH_MS = 60 * 60 * 1000;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const rolesOf = (id) => db.prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index').all(id);
const fieldCountOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM fields WHERE document_id = ?').get(id).n;
const columnsFor = (roles) => [...roles.flatMap((r) => [`${r.name} name`, `${r.name} email`]), 'Document title (optional)'];
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// A server restart stops a batch mid-way; say so rather than leave it "running".
db.prepare(`UPDATE bulk_batches SET status = 'interrupted', finished_at = ? WHERE status = 'running'`).run(nowIso());

function page(req, res, t, extra = {}, status = 200) {
  res.status(status).render('bulk', {
    template: t,
    roles: rolesOf(t.id),
    fieldCount: fieldCountOf(t.id),
    columns: columnsFor(rolesOf(t.id)),
    maxRows: MAX_ROWS,
    reminderChoices: REMINDER_CHOICES,
    values: { message: t.message || '', expires: 30, reminders: DEFAULT_REMINDER_DAYS },
    batches: db
      .prepare('SELECT * FROM bulk_batches WHERE template_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 5')
      .all(t.id, req.user.id),
    review: null,
    error: null,
    ...extra,
  });
}

router.get('/templates/:id/bulk', requireAuth, usableTemplate, (req, res) => page(req, res, req.doc));

/** The blank recipients file: just the header row, in the order the roles sign. */
router.get('/templates/:id/bulk.csv', requireAuth, usableTemplate, (req, res) => {
  const name = req.doc.title.replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'template';
  res.attachment(`${name} - recipients.csv`);
  res.type('text/csv; charset=utf-8');
  // The byte-order mark is what makes Excel read the file as UTF-8, so names
  // like Lötter survive the round trip instead of turning into mojibake.
  res.send('﻿' + toCsv([columnsFor(rolesOf(req.doc.id))]));
});

/** Reads and checks an upload; sends nothing. */
router.post('/templates/:id/bulk', requireAuth, usableTemplate, (req, res) => {
  upload.single('csv')(req, res, () => {
    const t = req.doc;
    const roles = rolesOf(t.id);
    const fail = (error) => page(req, res, t, { error }, 400);

    if (!req.file) return fail('Choose the CSV file to upload.');
    let rows;
    try {
      rows = parseCsv(req.file.buffer.toString('utf8'));
    } catch {
      return fail('That file could not be read as a CSV.');
    }
    if (!rows.length) return fail('That file is empty.');

    const header = rows[0].map(norm);
    const at = (label) => header.indexOf(norm(label));
    const cols = roles.map((r) => ({ role: r, name: at(`${r.name} name`), email: at(`${r.name} email`) }));
    const missing = cols.filter((c) => c.name < 0 || c.email < 0).map((c) => c.role.name);
    if (missing.length) {
      return fail(`The file has no name and email columns for ${missing.map((m) => `“${m}”`).join(', ')}. Download the blank CSV for this template and fill that in.`);
    }
    const titleCol = header.findIndex((h) => h.startsWith('document title'));

    const data = rows.slice(1);
    if (!data.length) return fail('The file has the right columns but no recipients in it yet.');
    if (data.length > MAX_ROWS) return fail(`That file has ${data.length} rows; one bulk send can take up to ${MAX_ROWS}. Split it into smaller files.`);

    const checked = data.map((r, i) => {
      const cell = (n) => (n >= 0 ? String(r[n] ?? '').trim() : '');
      const people = cols.map((c) => ({ name: cell(c.name).slice(0, 120), email: cell(c.email).toLowerCase().slice(0, 200) }));
      const problems = [];
      cols.forEach((c, k) => {
        if (!people[k].name) problems.push(`${c.role.name} name is missing`);
        if (!EMAIL.test(people[k].email)) {
          problems.push(people[k].email ? `${c.role.name} email “${people[k].email}” is not valid` : `${c.role.name} email is missing`);
        }
      });
      const title = (cell(titleCol) || `${t.title} — ${people[0].name || 'recipient'}`).slice(0, 200);
      return { line: i + 2, people, title, problems };
    });

    const ready = checked.filter((r) => !r.problems.length);
    req.session.bulk = { templateId: t.id, at: Date.now(), rows: ready.map(({ people, title }) => ({ people, title })) };
    page(req, res, t, { review: { rows: checked, ready: ready.length, skipped: checked.length - ready.length, filename: req.file.originalname } });
  });
});

/** Starts the batch from the checked upload kept in the session. */
router.post('/templates/:id/bulk/send', requireAuth, usableTemplate, (req, res) => {
  const t = req.doc;
  const stash = req.session.bulk;
  if (!stash || stash.templateId !== t.id || Date.now() - stash.at > STASH_MS || !stash.rows?.length) {
    return page(req, res, t, { error: 'Upload the recipients file again — the checked list has expired or belongs to another template.' }, 400);
  }
  if (!fieldCountOf(t.id)) {
    return page(req, res, t, { error: 'This template has no fields yet, so there is nothing for anyone to sign. Edit its fields first.' }, 400);
  }
  delete req.session.bulk;

  const expires = Math.min(Math.max(Number(req.body.expires_in_days) || 30, 1), 365);
  const options = {
    message: String(req.body.message || '').trim().slice(0, 2000) || null,
    expires,
    reminders: fitReminderDays(readReminderDays(req.body.reminder_days), expires),
  };

  const batchId = uuid();
  db.prepare(
    `INSERT INTO bulk_batches (id, company_id, owner_id, template_id, template_title, created_at, total)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(batchId, req.user.company_id, req.user.id, t.id, t.title, nowIso(), stash.rows.length);

  // Not awaited: the page that follows shows the progress.
  runBatch(batchId, t, stash.rows, options, req.user).catch((err) => console.error(`[bulk] ${err.message}`));
  res.redirect(`/bulk/${batchId}`);
});

async function runBatch(batchId, t, rows, options, user) {
  const bump = (col) => db.prepare(`UPDATE bulk_batches SET ${col} = ${col} + 1 WHERE id = ?`).run(batchId);
  for (const row of rows) {
    try {
      const id = cloneDocument(t, {
        ownerId: user.id,
        status: 'draft',
        title: row.title,
        message: options.message,
        signingOrder: t.signing_order,
        expiresAt: new Date(Date.now() + options.expires * 864e5).toISOString(),
        templateId: t.id,
        people: row.people,
      });
      db.prepare('UPDATE documents SET reminder_days = ?, bulk_batch_id = ? WHERE id = ?').run(options.reminders, batchId, id);
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
      audit({
        documentId: id,
        actor: user.email,
        action: 'Envelope created',
        detail: `Bulk send from template “${t.title}” · ${doc.filename} · SHA-256 ${doc.original_sha256}`,
      });
      const { flash } = await sendDocument({ doc, user, req: null });
      bump(flash.type === 'ok' ? 'sent' : 'undelivered');
    } catch (err) {
      console.error(`[bulk] ${batchId}: ${err.message}`);
      bump('failed');
    }
  }
  db.prepare(`UPDATE bulk_batches SET status = 'finished', finished_at = ? WHERE id = ?`).run(nowIso(), batchId);
}

/** Progress and results. The sender's own, like their documents. */
router.get('/bulk/:id', requireAuth, (req, res) => {
  const batch = db.prepare('SELECT * FROM bulk_batches WHERE id = ? AND owner_id = ?').get(req.params.id, req.user.id);
  if (!batch) return res.status(404).render('error', { code: 404, message: 'Bulk send not found.' });
  const docs = db
    .prepare(
      `SELECT d.id, d.title, d.status, d.deleted_at,
              (SELECT group_concat(name || ' <' || email || '>', ', ') FROM
                 (SELECT name, email FROM recipients r WHERE r.document_id = d.id ORDER BY r.order_index)) AS people
       FROM documents d WHERE d.bulk_batch_id = ? ORDER BY d.created_at`
    )
    .all(batch.id);
  res.render('bulk-batch', { batch, docs });
});

export default router;
