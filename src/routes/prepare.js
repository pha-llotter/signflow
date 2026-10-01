import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, ownedDocument } from '../middleware/auth.js';
import { uuid } from '../crypto.js';
import { FIELD_TYPES, FIELD_GROUPS, STAMP_PRESETS, isValidType } from '../fields.js';

const router = Router();

router.get('/documents/:id/prepare', requireAuth, ownedDocument, (req, res) => {
  if (req.doc.status !== 'draft') return res.redirect(`/documents/${req.doc.id}`);
  const recipients = db
    .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(req.doc.id);
  const fields = db.prepare('SELECT * FROM fields WHERE document_id = ?').all(req.doc.id);

  res.render('prepare', {
    doc: req.doc,
    recipients,
    fields: fields.map((f) => ({ ...f, meta: f.meta ? JSON.parse(f.meta) : {} })),
    pageSizes: JSON.parse(req.doc.page_sizes || '[]'),
    fieldTypes: FIELD_TYPES,
    fieldGroups: FIELD_GROUPS,
    stampPresets: STAMP_PRESETS,
  });
});

/**
 * Replaces the whole field set for a document in one transaction. The placer
 * owns the canonical layout client-side; a partial save would let a dropped
 * request leave orphaned fields behind.
 */
router.put('/api/documents/:id/fields', requireAuth, ownedDocument, (req, res) => {
  if (req.doc.status !== 'draft') {
    return res.status(409).json({ error: 'This document has been sent and can no longer be edited.' });
  }

  const incoming = Array.isArray(req.body.fields) ? req.body.fields : [];
  const validRecipients = new Set(
    db.prepare('SELECT id FROM recipients WHERE document_id = ?').all(req.doc.id).map((r) => r.id)
  );
  const pageCount = req.doc.page_count;

  const clean = [];
  for (const f of incoming) {
    if (!isValidType(f.type)) continue;
    const page = Number(f.page);
    if (!Number.isInteger(page) || page < 0 || page >= pageCount) continue;

    const spec = FIELD_TYPES[f.type];
    // Author-filled types (labels, stamps, QR) belong to the document, not a
    // signer; signer and auto types must name a recipient we actually have.
    let recipientId = null;
    if (spec.fill !== 'author') {
      recipientId = validRecipients.has(f.recipient_id) ? f.recipient_id : null;
      if (!recipientId) continue;
    }

    const clamp01 = (v, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : fallback;
    };
    const x = clamp01(f.x, 0);
    const y = clamp01(f.y, 0);
    const w = Math.min(clamp01(f.w, spec.w) || spec.w, 1 - x);
    const h = Math.min(clamp01(f.h, spec.h) || spec.h, 1 - y);

    clean.push({
      id: typeof f.id === 'string' && f.id.length === 36 ? f.id : uuid(),
      type: f.type,
      recipient_id: recipientId,
      page,
      x, y, w, h,
      required: f.required === false ? 0 : 1,
      font_size: Math.min(Math.max(Number(f.font_size) || 11, 5), 48),
      align: ['left', 'center', 'right'].includes(f.align) ? f.align : 'left',
      color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#111111',
      meta: JSON.stringify(sanitiseMeta(f.type, f.meta || {})),
    });
  }

  const replace = db.transaction((rows) => {
    db.prepare('DELETE FROM fields WHERE document_id = ?').run(req.doc.id);
    const stmt = db.prepare(
      `INSERT INTO fields (id, document_id, recipient_id, type, page, x, y, w, h, required, font_size, align, color, meta)
       VALUES (@id, @document_id, @recipient_id, @type, @page, @x, @y, @w, @h, @required, @font_size, @align, @color, @meta)`
    );
    for (const r of rows) stmt.run({ ...r, document_id: req.doc.id });
  });
  replace(clean);

  res.json({ ok: true, saved: clean.length });
});

function sanitiseMeta(type, meta) {
  const str = (v, max = 200) => String(v ?? '').slice(0, max);
  switch (type) {
    case 'signature':
      // Certification details are on unless the author turns them off.
      return { certified: meta.certified !== false };
    case 'label':
      return { text: str(meta.text) || 'Label' };
    case 'hyperlink':
      // Only http(s) — a javascript: or data: URL in a signed PDF is an attack surface.
      return {
        text: str(meta.text) || 'Link',
        url: /^https?:\/\//i.test(meta.url || '') ? str(meta.url, 500) : '',
      };
    case 'qrcode':
      return { data: str(meta.data, 500) };
    case 'stamp':
      return { text: str(meta.text, 40) || 'APPROVED', dated: meta.dated !== false };
    case 'dropdown':
    case 'radio':
      return {
        options: (Array.isArray(meta.options) ? meta.options : [])
          .map((o) => str(o, 80))
          .filter(Boolean)
          .slice(0, 20),
      };
    case 'editable_date':
      return { format: ['YYYY-MM-DD', 'DD/MM/YYYY'].includes(meta.format) ? meta.format : 'YYYY-MM-DD' };
    case 'textbox':
      return { placeholder: str(meta.placeholder, 60), multiline: !!meta.multiline };
    default:
      return {};
  }
}

export default router;
