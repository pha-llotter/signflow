import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

import { config } from './config.js';
import { db, nowIso } from './db.js';
import { sha256Buffer } from './crypto.js';
import { FIELD_TYPES } from './fields.js';
import { buildCertificate, formatStamp } from './certificate.js';
import { embedLogo } from './brand.js';

const INK_NAVY = rgb(0.06, 0.10, 0.19);
const INK_MUTED = rgb(0.42, 0.46, 0.52);
// The smallest certification text worth printing; below it, the detail is noise.
const MIN_CERT_PT = 4;
// A long, short field would otherwise grow its details to headline size.
const MAX_COMPACT_PT = 7.5;

/**
 * Maps a field rectangle — stored normalised against the page as it is
 * *displayed* — onto unrotated PDF user space.
 *
 * The placer renders pages through PDF.js, which honours the page's /Rotate
 * entry, but pdf-lib draws into the unrotated content stream. For a page with
 * no rotation these collapse to the obvious y-flip; for rotated scans the
 * anchor has to be carried round and the drawn content spun to match, or the
 * signature lands sideways in the margin.
 *
 * Returns the user-space anchor for the rectangle's visual bottom-left, the
 * rectangle's size along the visual axes, and the rotation to draw content at.
 */
/** A page's size as the reader sees it, with /Rotate applied. */
export function visualSize(page) {
  const { width: W, height: H } = page.getSize();
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const swapped = R === 90 || R === 270;
  return { w: swapped ? H : W, h: swapped ? W : H, rotation: R };
}

export function placeRect(page, f) {
  const { width: W, height: H } = page.getSize();
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const swapped = R === 90 || R === 270;
  const VW = swapped ? H : W;
  const VH = swapped ? W : H;

  const vx = f.x * VW;
  const vy = f.y * VH;
  const vw = f.w * VW;
  const vh = f.h * VH;
  // Visual bottom-left of the box, still in display coordinates.
  const bx = vx;
  const by = vy + vh;

  let x, y;
  switch (R) {
    case 90:  x = by;      y = bx;      break;
    case 180: x = W - bx;  y = by;      break;
    case 270: x = W - by;  y = H - bx;  break;
    default:  x = bx;      y = H - by;  break;
  }
  return { x, y, w: vw, h: vh, rotation: degrees(R) };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return rgb(0.07, 0.07, 0.07);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function alignedX(x, boxW, textW, align) {
  if (align === 'center') return x + (boxW - textW) / 2;
  if (align === 'right') return x + boxW - textW;
  return x;
}

/** Greedy wrap so long textbox answers stay inside their box instead of running off the page. */
function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

async function embedDataUrlImage(pdf, dataUrl) {
  const m = /^data:image\/(png|jpeg|jpg);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  return /png/i.test(m[1]) ? pdf.embedPng(bytes) : pdf.embedJpg(bytes);
}

/**
 * Flattens every field value into the page content, so the result is a plain
 * PDF that renders identically everywhere — not an interactive form whose
 * appearance depends on the viewer.
 */
async function stampFields(pdf, doc, fields, recipientsById) {
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;

    const spec = FIELD_TYPES[f.type];
    if (!spec) continue;
    const meta = f.meta ? JSON.parse(f.meta) : {};
    const box = placeRect(page, f);
    const color = hexToRgb(f.color);
    const size = f.font_size || 11;

    const drawText = (text, opts = {}) => {
      const font = opts.bold ? bold : helv;
      const fs = opts.size || size;
      const lines = wrap(text, font, fs, box.w);
      const lineHeight = fs * 1.2;
      lines.forEach((line, i) => {
        const tw = font.widthOfTextAtSize(line, fs);
        // Lay lines out from the top of the box downwards, in visual space.
        const offX = alignedX(0, box.w, tw, opts.align || f.align);
        const offY = box.h - fs - i * lineHeight;
        if (offY < -fs) return;
        const { x, y } = offsetInBox(box, offX, offY);
        page.drawText(line, { x, y, size: fs, font, color: opts.color || color, rotate: box.rotation });
      });
    };

    // A signature carries its own certification: who signed, from what address,
    // when, and against which document. A bare squiggle on a page proves
    // nothing on its own — the block is what makes the mark self-describing
    // when the PDF is printed or forwarded away from the audit trail.
    if (f.type === 'signature' && meta.certified !== false) {
      const drew = await drawSignatureBlock(pdf, page, box, {
        image: await embedDataUrlImage(pdf, f.value),
        doc,
        recipient: recipientsById.get(f.recipient_id),
        helv,
        bold,
      });
      if (drew) continue;
      // Too small to fit the block — fall through and draw the bare signature.
    }

    switch (spec.render) {
      case 'image': {
        const img = await embedDataUrlImage(pdf, f.value);
        if (!img) break;
        // Preserve aspect ratio inside the placed box.
        const scale = Math.min(box.w / img.width, box.h / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const { x, y } = offsetInBox(box, (box.w - w) / 2, 0);
        page.drawImage(img, { x, y, width: w, height: h, rotate: box.rotation });
        break;
      }
      case 'check': {
        const on = f.value === 'true' || f.value === '1' || f.value === 'on';
        const { x, y } = offsetInBox(box, 0, 0);
        page.drawRectangle({
          x, y, width: box.w, height: box.h,
          borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.8,
          rotate: box.rotation,
        });
        if (on) {
          const tick = Math.min(box.w, box.h) * 1.1;
          const p = offsetInBox(box, box.w * 0.18, box.h * 0.08);
          page.drawText('X', { x: p.x, y: p.y, size: tick, font: bold, color, rotate: box.rotation });
        }
        break;
      }
      case 'qr': {
        const data = meta.data || `${config.baseUrl}/verify/${doc.id}`;
        const png = await QRCode.toBuffer(data, { type: 'png', margin: 0, width: 512 });
        const img = await pdf.embedPng(png);
        const side = Math.min(box.w, box.h);
        const { x, y } = offsetInBox(box, (box.w - side) / 2, (box.h - side) / 2);
        page.drawImage(img, { x, y, width: side, height: side, rotate: box.rotation });
        break;
      }
      case 'stamp': {
        const text = (meta.text || 'APPROVED').toUpperCase();
        const stampColor = rgb(0.75, 0.13, 0.13);
        const { x, y } = offsetInBox(box, 0, 0);
        page.drawRectangle({
          x, y, width: box.w, height: box.h,
          borderColor: stampColor, borderWidth: 1.6, rotate: box.rotation,
        });
        const fs = Math.min(box.h * 0.42, box.w / (text.length * 0.62));
        const tw = bold.widthOfTextAtSize(text, fs);
        const t = offsetInBox(box, (box.w - tw) / 2, box.h * 0.52);
        page.drawText(text, { x: t.x, y: t.y, size: fs, font: bold, color: stampColor, rotate: box.rotation });
        if (meta.dated !== false) {
          const d = new Date().toISOString().slice(0, 10);
          const dfs = Math.max(fs * 0.5, 6);
          const dw = helv.widthOfTextAtSize(d, dfs);
          const p = offsetInBox(box, (box.w - dw) / 2, box.h * 0.16);
          page.drawText(d, { x: p.x, y: p.y, size: dfs, font: helv, color: stampColor, rotate: box.rotation });
        }
        break;
      }
      case 'link': {
        const label = meta.text || meta.url || 'Link';
        drawText(label, { color: rgb(0.11, 0.24, 0.48) });
        if (meta.url) {
          const { x, y } = offsetInBox(box, 0, 0);
          // A real link annotation, so the URL is clickable in the sealed PDF.
          page.node.addAnnot(
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot', Subtype: 'Link',
                Rect: [x, y, x + box.w, y + box.h],
                Border: [0, 0, 0],
                A: pdf.context.obj({ Type: 'Action', S: 'URI', URI: meta.url }),
              })
            )
          );
        }
        break;
      }
      default: {
        // Plain text: either the signer's answer or a system value.
        let text = f.value || '';
        if (f.type === 'label') text = meta.text || '';
        if (!text && f.type === 'name') text = recipientsById.get(f.recipient_id)?.name || '';
        if (!text && f.type === 'email') text = recipientsById.get(f.recipient_id)?.email || '';
        if (!text) break;
        drawText(text);
      }
    }
  }
}

/**
 * Draws the certification block that wraps a signature: a bracket down the
 * left, the short document reference above the mark, and who signed / from
 * what address / when below it.
 *
 * Everything is laid out in the box's own visual coordinates and mapped out
 * through offsetInBox, so the block stays upright and correctly placed on
 * rotated pages as well.
 *
 * Returns false when the box is too small for the text to be legible, letting
 * the caller fall back to stamping the signature on its own.
 */
async function drawSignatureBlock(pdf, page, box, { image, doc, recipient, helv, bold }) {
  const { w, h } = box;

  const docLine = `Doc ${doc.id.slice(0, 13)}`;
  const nameLine = `Signed by  ${recipient?.name || ''},`;
  const emailLine = recipient?.email || '';
  const timeLine = formatStamp(recipient?.signed_at || doc.completed_at);

  const contentX = w * 0.13;
  const contentW = w - contentX - w * 0.05;
  if (contentW <= 0) return false;

  // The wordmark shares the bottom line with the timestamp, so its footprint
  // has to be known before the text is sized — otherwise the two are laid out
  // independently and the logo lands on top of the time.
  const logo = await embedLogo(pdf, 'print');
  const markH = logo ? Math.min(h * 0.15, (w * 0.24 * logo.height) / logo.width) : 0;
  const markW = logo ? (markH * logo.width) / logo.height : 0;

  // Size the text to the longest line so nothing overruns the bracket, then
  // again against the narrower space the bottom line actually has.
  let fs = h * 0.105;
  const widest = Math.max(
    bold.widthOfTextAtSize(docLine, fs),
    bold.widthOfTextAtSize(nameLine, fs),
    helv.widthOfTextAtSize(emailLine, fs)
  );
  if (widest > contentW) fs *= contentW / widest;

  const timeRoom = w - contentX - markW - (markW ? w * 0.03 : w * 0.05);
  const timeWidth = () => bold.widthOfTextAtSize(timeLine, fs * 0.94);
  if (timeWidth() > timeRoom) fs *= timeRoom / timeWidth();

  // Below about 4pt this stops being readable in print and starts being noise.
  // A short field has the width but not the height for five stacked lines, so
  // it gets the side-by-side layout instead before giving up on the block.
  if (fs < MIN_CERT_PT) {
    return drawCompactSignatureBlock(page, box, { image, helv, bold, docLine, nameLine, emailLine, timeLine });
  }

  const at = (dx, dy) => offsetInBox(box, dx, dy);
  const text = (str, dx, dy, { font = bold, color = INK_NAVY, size = fs } = {}) => {
    const p = at(dx, dy);
    page.drawText(str, { x: p.x, y: p.y, size, font, color, rotate: box.rotation });
  };

  /** Draws a polyline given in visual box coordinates. */
  const polyline = (points, color, thickness) => {
    for (let i = 1; i < points.length; i++) {
      page.drawLine({
        start: at(points[i - 1][0], points[i - 1][1]),
        end: at(points[i][0], points[i][1]),
        thickness,
        color,
      });
    }
  };

  // --- the bracket ---------------------------------------------------------
  const r = Math.min(w * 0.05, h * 0.10);
  const stub = w * 0.10;
  const arc = (cx, cy, from, to) =>
    Array.from({ length: 7 }, (_, i) => {
      const a = from + ((to - from) * i) / 6;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });

  const rule = Math.max(h * 0.012, 0.6);
  // Both stubs stop short of contentX so the rule meets the text rather than
  // striking through it.
  polyline(
    [
      [stub, h],
      ...arc(r, h - r, Math.PI / 2, Math.PI),
      [0, r],
      ...arc(r, r, Math.PI, (3 * Math.PI) / 2),
      [contentX * 0.72, 0],
    ],
    INK_NAVY,
    rule
  );

  // --- the lines -----------------------------------------------------------
  // Baselines are spaced at roughly 1.3x the text size; any tighter and
  // descenders start colliding with the line beneath at small field sizes.
  text(docLine, contentX, h * 0.84);

  if (image) {
    // The mark sits in its own band and keeps its aspect ratio; a wide
    // signature shrinks to fit rather than spilling over the text below it.
    const bandY = h * 0.44;
    const bandH = h * 0.34;
    const bandW = contentW;
    const scale = Math.min(bandW / image.width, bandH / image.height);
    const iw = image.width * scale;
    const ih = image.height * scale;
    const p = at(contentX + (bandW - iw) / 2, bandY);
    page.drawImage(image, { x: p.x, y: p.y, width: iw, height: ih, rotate: box.rotation });
  }

  text(nameLine, contentX, h * 0.30);
  text(emailLine, contentX, h * 0.16, { font: helv, color: INK_MUTED, size: fs * 0.94 });
  text(timeLine, contentX, h * 0.03, { size: fs * 0.94 });

  // --- the brand mark ------------------------------------------------------
  // Bottom-right, sitting on the rule, in the space reserved for it above.
  if (logo) {
    const p = at(w - markW, h * 0.012);
    page.drawImage(logo, { x: p.x, y: p.y, width: markW, height: markH, rotate: box.rotation });
  }

  // Picks the rule back up after the timestamp and runs it to the mark, so the
  // block reads as one enclosed unit rather than a bracket and some loose text.
  const dashStart = contentX + timeWidth() + fs * 0.5;
  const dashEnd = w - markW - (markW ? fs * 0.45 : 0);
  if (dashEnd - dashStart > fs * 0.4) {
    polyline([[dashStart, 0], [dashEnd, 0]], INK_NAVY, rule);
  }

  return true;
}

/**
 * The certification block for a field that is wide but short — a signature
 * line drawn at the height of a line of text. The mark sits on the left and the
 * details stack in a column beside it, so the text is sized against the full
 * height rather than a tenth of it.
 *
 * The document reference, the signer and the time are what make the mark
 * self-describing, so they always print. The email is dropped first when the
 * column is too narrow: it is also on the certificate of completion, which
 * the reference leads to. Returns false only when even that will not fit at a
 * legible size, and the caller stamps the bare mark.
 */
function drawCompactSignatureBlock(page, box, { image, helv, bold, docLine, nameLine, emailLine, timeLine }) {
  const { w, h } = box;
  const LEAD = 1.2;

  const contentX = Math.max(h * 0.3, 5);
  const innerW = w - contentX - w * 0.03;
  const gap = Math.max(h * 0.16, 3);
  // The mark always keeps at least this share of the width, so the block never
  // becomes a caption with a signature-shaped speck beside it.
  const minMarkW = innerW * 0.3;
  const textRoom = innerW - minMarkW - gap;
  if (textRoom <= 0) return false;

  const lines = [
    { str: docLine, font: bold, color: INK_NAVY, scale: 1 },
    { str: nameLine, font: bold, color: INK_NAVY, scale: 1 },
    { str: emailLine, font: helv, color: INK_MUTED, scale: 0.94 },
    { str: timeLine, font: bold, color: INK_NAVY, scale: 0.94 },
  ];
  const fit = (set) => {
    // Tall enough for the stack with a little air top and bottom...
    let size = Math.min((h * 0.9) / (1 + (set.length - 1) * LEAD), MAX_COMPACT_PT);
    // ...and narrow enough for its longest line.
    const widest = Math.max(...set.map((l) => l.font.widthOfTextAtSize(l.str, size * l.scale)));
    if (widest > textRoom) size *= textRoom / widest;
    return size;
  };

  let set = lines.filter((l) => l.str);
  let fs = fit(set);
  if (fs < MIN_CERT_PT) {
    set = set.filter((l) => l.str !== emailLine);
    fs = fit(set);
  }
  if (fs < MIN_CERT_PT) return false;

  const at = (dx, dy) => offsetInBox(box, dx, dy);
  const textW = Math.max(...set.map((l) => l.font.widthOfTextAtSize(l.str, fs * l.scale)));
  // The mark gets what it needs to fill the height, within whatever the text
  // leaves — no more, or a long field strands the details at its far end.
  const bandH = h * 0.86;
  const wanted = image ? (image.width * bandH) / image.height : minMarkW;
  const markW = Math.min(Math.max(wanted, minMarkW), innerW - textW - gap);
  const textX = contentX + markW + gap;

  // --- the bracket, the same shape as the full block's ---------------------
  const r = Math.min(h * 0.18, w * 0.05);
  const stub = contentX * 1.4;
  const rule = Math.max(h * 0.02, 0.6);
  const arc = (cx, cy, from, to) =>
    Array.from({ length: 7 }, (_, i) => {
      const a = from + ((to - from) * i) / 6;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
  const points = [
    [stub, h],
    ...arc(r, h - r, Math.PI / 2, Math.PI),
    [0, r],
    ...arc(r, r, Math.PI, (3 * Math.PI) / 2),
    [stub, 0],
  ];
  for (let i = 1; i < points.length; i++) {
    page.drawLine({ start: at(...points[i - 1]), end: at(...points[i]), thickness: rule, color: INK_NAVY });
  }

  // --- the mark ------------------------------------------------------------
  if (image) {
    const scale = Math.min(markW / image.width, bandH / image.height);
    const iw = image.width * scale;
    const ih = image.height * scale;
    const p = at(contentX + (markW - iw) / 2, (h - ih) / 2);
    page.drawImage(image, { x: p.x, y: p.y, width: iw, height: ih, rotate: box.rotation });
  }

  // A hairline between the mark and the details, so they read as two halves
  // of one stamp rather than a signature with some text that happens to be near.
  const divX = contentX + markW + gap / 2;
  page.drawLine({ start: at(divX, h * 0.1), end: at(divX, h * 0.9), thickness: rule * 0.6, color: INK_MUTED });

  // --- the details, centred on the box's height ----------------------------
  const lead = fs * LEAD;
  const blockH = fs + (set.length - 1) * lead;
  let baseline = (h + blockH) / 2 - fs * 0.8;
  for (const l of set) {
    const p = at(textX, baseline);
    page.drawText(l.str, { x: p.x, y: p.y, size: fs * l.scale, font: l.font, color: l.color, rotate: box.rotation });
    baseline -= lead;
  }

  return true;
}

/** Moves along the box's visual axes from its anchor, honouring page rotation. */
function offsetInBox(box, dx, dy) {
  const deg = box.rotation.angle;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: box.x + dx * cos - dy * sin, y: box.y + dx * sin + dy * cos };
}

/**
 * Prints a provenance line along the bottom of every page of the sealed
 * document, so a page that gets separated from the rest — printed, photocopied,
 * pulled out of a bundle — still says where it came from and which record it
 * belongs to. The certificate at the back carries its own footer and is added
 * after this runs, so it is not double-stamped.
 *
 * It sits in the bottom margin. On a document whose own content runs to the
 * very edge of the page it will overlap, which is why `PAGE_FOOTER=off` exists.
 */
async function stampPageFooters(pdf, doc) {
  if (!config.pageFooter) return;

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const text = config.pageFooterText
    .replace('{brand}', config.brand.name)
    .replace('{id}', doc.id);
  const colour = rgb(0.56, 0.59, 0.64);

  for (const page of pdf.getPages()) {
    const { h: VH } = visualSize(page);
    const size = Math.min(6.8, VH * 0.009);
    // Anchor a zero-height strip whose baseline sits a fixed distance above the
    // visual bottom edge, then let placeRect carry it round any page rotation.
    const inset = Math.max(14, VH * 0.022);
    const box = placeRect(page, { x: 0.05, y: 1 - inset / VH, w: 0.9, h: 0 });

    const width = font.widthOfTextAtSize(text, size);
    // Centre it, unless the text is wider than the strip — then start at the left
    // edge so the beginning stays readable rather than bleeding off both sides.
    const dx = width < box.w ? (box.w - width) / 2 : 0;
    const { x, y } = offsetInBox(box, dx, 0);
    page.drawText(text, { x, y, size, font, color: colour, rotate: box.rotation });
  }
}

/**
 * Appends anything dropped into an attachment field to the back of the
 * document, so the sealed PDF is the whole record rather than a pointer to
 * files held somewhere else. PDFs keep their pages; images get a page each.
 */
async function appendAttachments(pdf, documentId) {
  const rows = db
    .prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at')
    .all(documentId);
  if (!rows.length) return;

  const helv = await pdf.embedFont(StandardFonts.Helvetica);

  for (const a of rows) {
    if (!fs.existsSync(a.path)) continue;
    const bytes = fs.readFileSync(a.path);

    if (a.mime === 'application/pdf') {
      try {
        const src = await PDFDocument.load(bytes);
        const copied = await pdf.copyPages(src, src.getPageIndices());
        copied.forEach((p) => pdf.addPage(p));
      } catch {
        // A PDF we cannot parse should not sink the whole seal — it stays in
        // storage and on the audit trail, it just is not inlined.
        continue;
      }
    } else {
      const img = a.mime === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      const page = pdf.addPage([595.28, 841.89]);
      const scale = Math.min((595.28 - 80) / img.width, (841.89 - 120) / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2 - 10, width: w, height: h });
      page.drawText(`Attachment: ${a.filename}`, {
        x: 40, y: 841.89 - 46, size: 9, font: helv, color: rgb(0.45, 0.48, 0.53),
      });
    }
  }
}

/**
 * Produces the final artefact for a completed document:
 *   1. flatten every field value into the original PDF
 *   2. hash that — this is the "signed document" hash printed on the certificate
 *   3. append the certificate of completion
 *   4. hash the whole file — this is what /verify checks a download against
 *
 * Step 2 exists because a certificate cannot contain the hash of a file it is
 * itself part of. Both hashes are stored and both are shown to the user.
 */
export async function sealDocument(documentId) {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(documentId);
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(doc.owner_id);
  const recipients = db
    .prepare('SELECT * FROM recipients WHERE document_id = ? ORDER BY order_index')
    .all(documentId);
  const fields = db.prepare('SELECT * FROM fields WHERE document_id = ?').all(documentId);
  const events = db
    .prepare('SELECT * FROM audit_events WHERE document_id = ? ORDER BY id')
    .all(documentId);

  const recipientsById = new Map(recipients.map((r) => [r.id, r]));
  const pdf = await PDFDocument.load(fs.readFileSync(doc.original_path));

  await stampFields(pdf, doc, fields, recipientsById);
  await appendAttachments(pdf, documentId);
  // After the attachments, so appended pages carry the line too.
  await stampPageFooters(pdf, doc);

  // Deterministic metadata: two seals of the same evidence should hash alike.
  pdf.setTitle(doc.title);
  pdf.setProducer(`${config.brand.name} (sealed)`);
  pdf.setCreator(config.brand.name);
  const sealTime = new Date(doc.completed_at || nowIso());
  pdf.setModificationDate(sealTime);
  pdf.setCreationDate(sealTime);

  const signedBytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const signedSha = sha256Buffer(signedBytes);

  const finalPdf = await PDFDocument.load(signedBytes);
  await buildCertificate(finalPdf, {
    doc: { ...doc, signed_sha256: signedSha },
    owner,
    recipients,
    events,
  });
  finalPdf.setTitle(doc.title);
  finalPdf.setProducer(`${config.brand.name} (sealed)`);
  finalPdf.setModificationDate(sealTime);
  finalPdf.setCreationDate(sealTime);

  const sealedBytes = Buffer.from(await finalPdf.save({ useObjectStreams: false }));
  const sealedSha = sha256Buffer(sealedBytes);
  const sealedPath = path.join(config.storageDir, 'sealed', `${doc.id}.pdf`);
  fs.writeFileSync(sealedPath, sealedBytes);

  db.prepare(
    `UPDATE documents SET sealed_path = ?, sealed_sha256 = ?, signed_sha256 = ? WHERE id = ?`
  ).run(sealedPath, sealedSha, signedSha, doc.id);

  return { sealedPath, sealedSha, signedSha, bytes: sealedBytes };
}
