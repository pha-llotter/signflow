import { StandardFonts, rgb } from 'pdf-lib';
import { config } from './config.js';
import { embedLogo } from './brand.js';
import { embedCompanyLogo, fitLogo } from './company-logo.js';
import { version } from './version.js';

const INK = rgb(0.07, 0.09, 0.13);
const NAVY = rgb(0.10, 0.20, 0.42);
const MUTED = rgb(0.45, 0.48, 0.53);
const FAINT = rgb(0.62, 0.65, 0.70);
const RULE = rgb(0.82, 0.84, 0.87);

const TZ = config.displayTz;

/**
 * Renders a timestamp the way the audit trail has to read it: local wall-clock
 * time with the offset spelled out, so a reader a year later in another
 * timezone can still place the event exactly.
 */
export function formatStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  // Derive the offset by asking what that wall-clock time is in UTC terms.
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offsetMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second}(${off})`;
}

const A4 = [595.28, 841.89];
const MARGIN = 56;

/**
 * Appends the certificate of completion. Everything on it is read back out of
 * the audit table rather than recomputed, so the page and the database can
 * never disagree about what happened.
 */
export async function buildCertificate(pdf, { doc, owner, recipients, events }) {
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pages = [];
  let page = null;
  let y = 0;

  const newPage = () => {
    page = pdf.addPage(A4);
    pages.push(page);
    y = A4[1] - MARGIN;
    return page;
  };

  const text = (str, { x = MARGIN, size = 9.5, font = helv, color = INK, dy = 0 } = {}) => {
    page.drawText(String(str ?? ''), { x, y: y - dy, size, font, color });
  };

  /** Reserves vertical space, starting a new page when the block will not fit. */
  const need = (h) => {
    if (y - h < MARGIN + 28) {
      newPage();
      text('Certificate of Completion (continued)', { size: 11, font: bold, color: NAVY });
      y -= 26;
    }
  };

  const rule = (width = A4[0] - MARGIN * 2) => {
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: MARGIN + width, y },
      thickness: 0.75, color: RULE,
    });
  };

  // Long hex strings have no spaces to break on, so wrap them by measured width.
  const wrapMono = (str, size, maxWidth) => {
    const chunks = [];
    let line = '';
    for (const ch of String(str)) {
      if (helv.widthOfTextAtSize(line + ch, size) > maxWidth) { chunks.push(line); line = ch; }
      else line += ch;
    }
    if (line) chunks.push(line);
    return chunks;
  };

  newPage();

  // ---- Header -------------------------------------------------------------
  // The sending company's own logo leads, above the title. The platform mark
  // stays top-right, a size smaller: the company issued the document, the
  // platform sealed it, and the certificate should read in that order.
  const companyLogo = await embedCompanyLogo(pdf, doc.company_id || owner.company_id);
  if (companyLogo) {
    const { w, h } = fitLogo(companyLogo.width, companyLogo.height, 170, 44);
    page.drawImage(companyLogo, { x: MARGIN, y: y + 12 - h, width: w, height: h });
    y -= h + 12;
  }

  text('Certificate of Completion', { size: 19, font: bold, color: NAVY });

  const logo = await embedLogo(pdf, 'print');
  if (logo) {
    const logoH = companyLogo ? 20 : 26;
    const logoW = (logoH * logo.width) / logo.height;
    page.drawImage(logo, { x: A4[0] - MARGIN - logoW, y: y - 6, width: logoW, height: logoH });
  } else {
    // No asset built yet — the certificate still has to say who issued it.
    const brandW = bold.widthOfTextAtSize(config.brand.name, 13);
    text(config.brand.name, { x: A4[0] - MARGIN - brandW, size: 13, font: bold, color: NAVY, dy: 3 });
  }
  y -= 26;
  rule();
  y -= 26;

  // ---- Document -----------------------------------------------------------
  text('Document', { size: 8, font: bold, color: MUTED });
  y -= 15;
  text(doc.title, { size: 14, font: bold });
  y -= 20;
  text(`Document ID:  ${doc.id}`, { size: 9 });
  y -= 14;

  for (const [caption, value] of [
    ['Original document hash (SHA-256):', doc.original_sha256],
    ['Signed document hash (SHA-256):', doc.signed_sha256],
  ]) {
    if (!value) continue;
    text(caption, { size: 7.5, color: MUTED });
    const capW = helv.widthOfTextAtSize(caption, 7.5);
    const lines = wrapMono(value, 7.5, A4[0] - MARGIN * 2 - capW - 8);
    lines.forEach((line, i) => {
      page.drawText(line, { x: MARGIN + capW + 8, y: y - i * 9.5, size: 7.5, font: helv, color: INK });
    });
    y -= Math.max(lines.length * 9.5, 12);
  }

  y -= 6;
  text('The signed hash covers this document with every signature flattened into it, before this', { size: 7, color: FAINT });
  y -= 9;
  text('certificate page was appended. Verify a download at ' + `${config.baseUrl}/verify/${doc.id}`, { size: 7, color: FAINT });
  y -= 22;

  text('Sent by', { size: 8, font: bold, color: MUTED });
  y -= 14;
  text(`${owner.display_name}`, { size: 11, font: bold });
  const nameW = bold.widthOfTextAtSize(owner.display_name, 11);
  text(`<${owner.email}>`, { x: MARGIN + nameW + 8, size: 10, color: INK });
  // The organisation the document was sent on behalf of. Older envelopes and
  // a sender outside any company simply omit the line.
  if (owner.org_name) {
    y -= 13;
    text(owner.org_name, { size: 9.5, color: MUTED });
  }
  y -= 30;

  // ---- Recipients ---------------------------------------------------------
  text('Recipients and verification', { size: 12.5, font: bold, color: NAVY });
  y -= 22;

  for (const r of recipients) {
    const rEvents = events.filter((e) => e.recipient_id === r.id);
    need(28 + rEvents.length * 13 + 18);

    text(r.name, { size: 11, font: bold });
    const statusLabel = { signed: 'Signed', declined: 'Declined', viewed: 'Viewed', pending: 'Pending' }[r.status] || r.status;
    const sw = bold.widthOfTextAtSize(statusLabel, 9.5);
    text(statusLabel, {
      x: A4[0] - MARGIN - sw, size: 9.5, font: bold,
      color: r.status === 'signed' ? NAVY : MUTED,
    });
    y -= 13;
    text(r.email, { size: 8.5, color: MUTED });
    y -= 15;

    // Most recent first, the way a reviewer reads a signature block.
    const steps = [...rEvents].reverse();
    steps.forEach((e, i) => {
      text(String(i + 1), { x: MARGIN + 10, size: 8, color: FAINT });
      text(e.action, { x: MARGIN + 24, size: 8.5 });
      text(formatStamp(e.created_at), { x: MARGIN + 210, size: 8.5 });
      text(e.ip || '—', { x: MARGIN + 350, size: 8.5, color: FAINT });
      y -= 13;
    });

    if (r.consent_at) {
      text('Consented to sign electronically and to the recording of this audit trail.', {
        x: MARGIN + 24, size: 7.5, color: FAINT,
      });
      y -= 11;
    }
    if (r.decline_note) {
      text(`Reason given: ${r.decline_note}`, { x: MARGIN + 24, size: 7.5, color: FAINT });
      y -= 11;
    }
    y -= 10;
  }

  // ---- Activity -----------------------------------------------------------
  y -= 8;
  need(40);
  text('Activity', { size: 12.5, font: bold, color: NAVY });
  y -= 20;

  for (const e of [...events].reverse()) {
    need(13);
    text(formatStamp(e.created_at), { size: 8 });
    text(e.ip || '—', { x: MARGIN + 150, size: 8, color: FAINT });
    const line = e.detail ? `${e.actor} — ${e.action}: ${e.detail}` : `${e.actor} — ${e.action}`;
    const maxW = A4[0] - MARGIN - (MARGIN + 240);
    let shown = line;
    while (helv.widthOfTextAtSize(shown, 8) > maxW && shown.length > 4) shown = shown.slice(0, -2);
    if (shown !== line) shown = `${shown.slice(0, -1)}…`;
    text(shown, { x: MARGIN + 240, size: 8 });
    y -= 12;
  }

  // ---- Footer -------------------------------------------------------------
  pages.forEach((p, i) => {
    // The build is recorded here deliberately. If a defect is ever found in the
    // sealing or hashing, this is what says whether a given document was
    // produced by the affected code.
    const footer = `Certificate page ${i + 1} of ${pages.length}  ·  Document ${doc.id}  ·  Stored in ${config.dataRegion}  ·  ${config.brand.name} ${version.stamp}`;
    p.drawLine({
      start: { x: MARGIN, y: MARGIN - 6 }, end: { x: A4[0] - MARGIN, y: MARGIN - 6 },
      thickness: 0.5, color: RULE,
    });
    p.drawText(footer, { x: MARGIN, y: MARGIN - 18, size: 6.5, font: helv, color: FAINT });
  });

  return pages.length;
}
