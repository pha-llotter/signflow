import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { config } from '../config.js';
import { db, nowIso, audit } from '../db.js';
import { requireAuth, ownedDocument, usableTemplate, canManageTemplate } from '../middleware/auth.js';
import { sha256Buffer, uuid } from '../crypto.js';
import { cloneDocument } from '../clone.js';
import { sendDocument } from './documents.js';
import { readReminderDays, fitReminderDays, REMINDER_CHOICES, DEFAULT_REMINDER_DAYS } from '../reminders.js';

const router = Router();

const VISIBILITIES = ['private', 'team'];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_ROLES = 20;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF files can be uploaded.'), ok);
  },
});

const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Template not found.' });

/** Role rows arrive as parallel arrays; blank labels are dropped. */
function readRoles(body) {
  const ids = [].concat(body.role_id ?? []);
  const names = [].concat(body.role_name ?? []);
  return names
    .map((n, i) => ({ id: String(ids[i] || ''), name: String(n || '').trim().slice(0, 80) }))
    .filter((r) => r.name)
    .slice(0, MAX_ROLES);
}

function readDetails(body) {
  return {
    title: String(body.title || '').trim().slice(0, 200),
    message: String(body.message || '').trim().slice(0, 2000) || null,
    visibility: VISIBILITIES.includes(body.visibility) ? body.visibility : 'private',
    signingOrder: body.signing_order ? 1 : 0,
  };
}

function rolesOf(id) {
  return db.prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index').all(id);
}

/* ------------------------------------------------------------------- list */

router.get('/templates', requireAuth, (req, res) => {
  const all = db
    .prepare(
      `SELECT d.*, u.display_name AS owner_name,
              (SELECT group_concat(name, ', ') FROM
                 (SELECT name FROM recipients r WHERE r.document_id = d.id ORDER BY r.order_index)) AS roles,
              (SELECT COUNT(*) FROM fields f WHERE f.document_id = d.id) AS field_count,
              (SELECT COUNT(*) FROM documents x WHERE x.template_id = d.id) AS uses
       FROM documents d JOIN users u ON u.id = d.owner_id
       WHERE d.status = 'template'
         AND (d.owner_id = ? OR (d.template_visibility = 'team' AND d.company_id = ?))
       ORDER BY d.title COLLATE NOCASE`
    )
    .all(req.user.id, req.user.company_id);

  const show = ['team', 'private'].includes(req.query.show) ? req.query.show : null;
  const templates = all
    .filter((t) => !show || t.template_visibility === show)
    .map((t) => ({
      ...t,
      mine: t.owner_id === req.user.id,
      canManage: canManageTemplate(req.user, t),
    }));
  const counts = {
    all: all.length,
    team: all.filter((t) => t.template_visibility === 'team').length,
    private: all.filter((t) => t.template_visibility === 'private').length,
  };
  // Arriving from "Bulk send" in the Create new menu: the same list, with
  // bulk sending as each card's main action.
  const bulk = req.query.for === 'bulk';
  res.render('templates', { templates, counts, show, bulk });
});

/* ----------------------------------------------------------------- create */

const blankForm = { title: '', message: '', visibility: 'private', signingOrder: 0, roles: [{ id: '', name: 'Signer' }] };

router.get('/templates/new', requireAuth, (req, res) => {
  res.render('template-form', { mode: 'new', values: blankForm, error: null });
});

router.post('/templates/new', requireAuth, (req, res, next) => {
  upload.single('pdf')(req, res, async (err) => {
    const values = { ...readDetails(req.body), roles: readRoles(req.body) };
    const fail = (error) => res.status(400).render('template-form', {
      mode: 'new', values: { ...values, roles: values.roles.length ? values.roles : blankForm.roles }, error,
    });

    try {
      if (err) {
        return fail(err.code === 'LIMIT_FILE_SIZE'
          ? `That file is larger than the ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB limit.`
          : err.message || 'That upload could not be read.');
      }
      if (!req.file) return fail('Choose a PDF to upload.');
      if (!values.roles.length) return fail('Add at least one role, such as "Client" or "Employee".');

      let pdf;
      try {
        pdf = await PDFDocument.load(req.file.buffer, { ignoreEncryption: false });
      } catch {
        return fail('That PDF could not be read. Password-protected files must be unlocked first.');
      }
      const pageSizes = pdf.getPages().map((p) => {
        const { width, height } = p.getSize();
        return { w: width, h: height, rotation: p.getRotation().angle };
      });

      const id = uuid();
      const storedPath = path.join(config.storageDir, 'originals', `${id}.pdf`);
      fs.writeFileSync(storedPath, req.file.buffer);

      db.transaction(() => {
        db.prepare(
          `INSERT INTO documents (id, owner_id, title, message, filename, page_count, page_sizes,
             original_path, original_sha256, status, signing_order, created_at, template_visibility, company_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'template', ?, ?, ?, ?)`
        ).run(
          id, req.user.id, values.title || req.file.originalname.replace(/\.pdf$/i, ''), values.message,
          req.file.originalname, pageSizes.length, JSON.stringify(pageSizes), storedPath,
          sha256Buffer(req.file.buffer), values.signingOrder, nowIso(), values.visibility, req.user.company_id
        );
        const insert = db.prepare(
          `INSERT INTO recipients (id, document_id, name, email, order_index) VALUES (?, ?, ?, '', ?)`
        );
        values.roles.forEach((r, i) => insert.run(uuid(), id, r.name, i));
      })();

      res.redirect(`/documents/${id}/prepare`);
    } catch (e) {
      next(e);
    }
  });
});

/* ------------------------------------------------------------ edit details */

router.get('/templates/:id/edit', requireAuth, usableTemplate, (req, res) => {
  if (!req.canManage) return notFound(res);
  const t = req.doc;
  res.render('template-form', {
    mode: 'edit', template: t, error: null,
    values: {
      title: t.title, message: t.message || '', visibility: t.template_visibility,
      signingOrder: t.signing_order, roles: rolesOf(t.id).map((r) => ({ id: r.id, name: r.name })),
    },
  });
});

router.post('/templates/:id/edit', requireAuth, usableTemplate, (req, res) => {
  if (!req.canManage) return notFound(res);
  const t = req.doc;
  const values = { ...readDetails(req.body), roles: readRoles(req.body) };
  if (!values.title || !values.roles.length) {
    return res.status(400).render('template-form', {
      mode: 'edit', template: t, values,
      error: !values.title ? 'Give the template a name.' : 'Keep at least one role.',
    });
  }

  const existing = new Set(rolesOf(t.id).map((r) => r.id));
  db.transaction(() => {
    db.prepare(
      `UPDATE documents SET title = ?, message = ?, template_visibility = ?, signing_order = ? WHERE id = ?`
    ).run(values.title, values.message, values.visibility, values.signingOrder, t.id);

    // A removed role takes its fields with it (ON DELETE CASCADE).
    const kept = new Set(values.roles.map((r) => r.id).filter((id) => existing.has(id)));
    for (const id of existing) {
      if (!kept.has(id)) db.prepare('DELETE FROM recipients WHERE id = ?').run(id);
    }
    values.roles.forEach((r, i) => {
      if (kept.has(r.id)) {
        db.prepare('UPDATE recipients SET name = ?, order_index = ? WHERE id = ?').run(r.name, i, r.id);
      } else {
        db.prepare(`INSERT INTO recipients (id, document_id, name, email, order_index) VALUES (?, ?, ?, '', ?)`)
          .run(uuid(), t.id, r.name, i);
      }
    });
  })();

  req.session.flash = { type: 'ok', text: `“${values.title}” saved.` };
  res.redirect('/templates');
});

router.post('/templates/:id/delete', requireAuth, usableTemplate, (req, res) => {
  if (!req.canManage) return notFound(res);
  if (fs.existsSync(req.doc.original_path)) fs.unlinkSync(req.doc.original_path);
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.doc.id);
  req.session.flash = { type: 'ok', text: `Template “${req.doc.title}” deleted. Documents already sent from it are unaffected.` };
  res.redirect('/templates');
});

/* -------------------------------------------------------------------- use */

router.get('/templates/:id/use', requireAuth, usableTemplate, (req, res) => {
  const t = req.doc;
  res.render('template-use', {
    template: t,
    roles: rolesOf(t.id),
    fieldCount: db.prepare('SELECT COUNT(*) AS n FROM fields WHERE document_id = ?').get(t.id).n,
    values: { title: t.title, message: t.message || '', expires: 30, reminders: DEFAULT_REMINDER_DAYS, people: {} },
    reminderChoices: REMINDER_CHOICES,
    error: null,
  });
});

router.post('/templates/:id/use', requireAuth, usableTemplate, async (req, res, next) => {
  try {
    const t = req.doc;
    const roles = rolesOf(t.id);
    const people = roles.map((r) => ({
      name: String(req.body[`name_${r.id}`] || '').trim().slice(0, 120),
      email: String(req.body[`email_${r.id}`] || '').trim().toLowerCase().slice(0, 200),
    }));
    const values = {
      title: String(req.body.title || '').trim().slice(0, 200) || t.title,
      message: String(req.body.message || '').trim().slice(0, 2000),
      expires: Math.min(Math.max(Number(req.body.expires_in_days) || 30, 1), 365),
      reminders: 0, // fitted to the expiry just below
      people: Object.fromEntries(roles.map((r, i) => [r.id, people[i]])),
    };
    values.reminders = fitReminderDays(readReminderDays(req.body.reminder_days), values.expires);

    const missing = roles.find((r, i) => !people[i].name || !EMAIL.test(people[i].email));
    if (missing) {
      return res.status(400).render('template-use', {
        template: t, roles, values, reminderChoices: REMINDER_CHOICES,
        fieldCount: db.prepare('SELECT COUNT(*) AS n FROM fields WHERE document_id = ?').get(t.id).n,
        error: `Enter a name and a valid email for “${missing.name}”.`,
      });
    }

    const id = cloneDocument(t, {
      ownerId: req.user.id,
      status: 'draft',
      title: values.title,
      message: values.message || null,
      signingOrder: t.signing_order,
      expiresAt: new Date(Date.now() + values.expires * 864e5).toISOString(),
      templateId: t.id,
      people,
    });
    db.prepare('UPDATE documents SET reminder_days = ? WHERE id = ?').run(values.reminders, id);
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    audit({
      documentId: id,
      actor: req.user.email,
      action: 'Envelope created',
      detail: `From template “${t.title}” · ${doc.filename} · ${doc.page_count} page(s) · SHA-256 ${doc.original_sha256}`,
      req,
    });

    if (req.body.action === 'send') {
      const { flash, to } = await sendDocument({ doc, user: req.user, req });
      req.session.flash = flash;
      return res.redirect(to);
    }
    res.redirect(`/documents/${id}/prepare`);
  } catch (err) {
    next(err);
  }
});

/* ------------------------------------------------- save a document as one */

router.get('/documents/:id/save-template', requireAuth, ownedDocument, (req, res) => {
  res.render('save-template', {
    doc: req.doc,
    recipients: rolesOf(req.doc.id),
    values: { title: req.doc.title, visibility: 'private', roles: {} },
    error: null,
  });
});

router.post('/documents/:id/save-template', requireAuth, ownedDocument, (req, res, next) => {
  try {
    const recipients = rolesOf(req.doc.id);
    const labels = recipients.map((r, i) =>
      String(req.body[`role_${r.id}`] || '').trim().slice(0, 80) || `Signer ${i + 1}`);
    const title = String(req.body.title || '').trim().slice(0, 200) || req.doc.title;
    const visibility = VISIBILITIES.includes(req.body.visibility) ? req.body.visibility : 'private';

    cloneDocument(req.doc, {
      ownerId: req.user.id,
      status: 'template',
      title,
      message: req.doc.message,
      signingOrder: req.doc.signing_order,
      visibility,
      people: labels.map((name) => ({ name, email: '' })),
    });

    req.session.flash = { type: 'ok', text: `Saved “${title}” as a ${visibility === 'team' ? 'team' : 'private'} template.` };
    res.redirect('/templates');
  } catch (err) {
    next(err);
  }
});

export default router;
