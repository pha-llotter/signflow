import { config } from './config.js';

/**
 * The house style for every message the app sends.
 *
 * Written as nested tables with inline styles, which looks archaic next to the
 * rest of the app but is the only thing Outlook renders reliably — it uses
 * Word's engine, which supports no flexbox, no grid, no `<style>` blocks worth
 * relying on, and no shorthand backgrounds. Everything here is deliberate.
 */

const C = {
  page: '#e9edf0',
  card: '#ffffff',
  header: '#101c38',
  accent: '#1e8bf0',
  cta: '#1668dc',
  ctaText: '#ffffff',
  heading: '#132347',
  body: '#3a414c',
  muted: '#8a919c',
  faint: '#a7adb7',
  panel: '#f4f7fa',
  line: '#e4e8ee',
  footer: '#f7f9fb',
  danger: '#b3261e',
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** "27 Sep 2026 11:05" in the configured timezone. */
export function sentStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.displayTz,
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
    .format(date)
    .replace(',', '');
}

/**
 * @param {object}   o
 * @param {string}   o.heading      big line under the header band
 * @param {string[]} o.paragraphs   body copy, already escaped
 * @param {object}  [o.cta]         { label, url }
 * @param {object[]}[o.panels]      [{ label, value, mono }] supporting detail
 * @param {string}  [o.note]        small print above the footer
 * @param {boolean} [o.hasLogo]     false renders the brand name as text instead
 */
export function renderEmail({ heading, paragraphs = [], cta, panels = [], note, hasLogo = true }) {
  const brand = esc(config.brand.name);

  const logoBlock = hasLogo
    ? `<img src="cid:signflow-logo" width="150" alt="${brand}" style="display:block;border:0;outline:none;text-decoration:none;width:150px;max-width:150px;height:auto;">`
    : `<div style="font:700 21px/1.2 ${FONT};color:#ffffff;letter-spacing:.06em;">${brand.toUpperCase()}</div>`;

  const bodyRows = paragraphs
    .map(
      (p) =>
        `<tr><td style="padding:0 32px 14px;font:400 15px/1.62 ${FONT};color:${C.body};">${p}</td></tr>`
    )
    .join('');

  // A bulletproof button: the background lives on the <td> so Outlook, which
  // ignores padding on an <a>, still paints a full-size block.
  const ctaRow = cta
    ? `<tr><td align="center" style="padding:14px 32px 6px;">
         <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
           <td align="center" bgcolor="${C.cta}" style="border-radius:8px;">
             <a href="${esc(cta.url)}" target="_blank"
                style="display:inline-block;padding:15px 34px;font:700 15px/1 ${FONT};color:${C.ctaText};text-decoration:none;border-radius:8px;">
               ${esc(cta.label)}
             </a>
           </td>
         </tr></table>
       </td></tr>
       <tr><td align="center" style="padding:14px 32px 0;font:400 12px/1.6 ${FONT};color:${C.faint};">
         If the button does not work, copy this link into your browser:<br>
         <a href="${esc(cta.url)}" style="color:${C.accent};text-decoration:underline;word-break:break-all;">${esc(cta.url)}</a>
       </td></tr>`
    : '';

  const panelRows = panels.length
    ? `<tr><td style="padding:22px 32px 0;">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                style="background:${C.panel};border:1px solid ${C.line};border-radius:8px;">
           ${panels
             .map(
               (p, i) => `<tr>
                 <td style="padding:${i === 0 ? '14px' : '0'} 16px 12px;">
                   <div style="font:600 11px/1.4 ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.05em;padding-bottom:3px;">${esc(p.label)}</div>
                   <div style="font:${p.mono ? `400 12px/1.5 Consolas,'Courier New',monospace` : `400 14px/1.5 ${FONT}`};color:${C.heading};word-break:${p.mono ? 'break-all' : 'normal'};">${esc(p.value)}</div>
                 </td></tr>`
             )
             .join('')}
         </table>
       </td></tr>`
    : '';

  const noteRow = note
    ? `<tr><td style="padding:20px 32px 0;font:400 12.5px/1.6 ${FONT};color:${C.muted};">${note}</td></tr>`
    : '';

  const legal = [config.brand.legalName, config.brand.regNo ? `Reg. No. ${config.brand.regNo}` : '']
    .filter(Boolean)
    .map(esc)
    .join(' · ');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<!-- Mail clients in dark mode will auto-invert a light design, which turns the
     navy header muddy and can leave the button unreadable. The design already
     has enough contrast, so opt out and keep it identical for every recipient
     rather than following the app's own theme, which is not theirs. -->
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<style>:root{color-scheme:light only;supported-color-schemes:light only;}</style>
<title>${esc(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(heading)} — ${brand}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:28px 12px 34px;">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
           style="width:600px;max-width:100%;background:${C.card};border-radius:10px;overflow:hidden;">

      <tr><td align="center" bgcolor="${C.header}" style="background:${C.header};padding:26px 24px 24px;">
        ${logoBlock}
      </td></tr>
      <tr><td bgcolor="${C.accent}" style="background:${C.accent};height:4px;line-height:4px;font-size:0;">&nbsp;</td></tr>

      <tr><td align="center" style="padding:32px 32px 18px;font:700 22px/1.3 ${FONT};color:${C.heading};">
        ${esc(heading)}
      </td></tr>

      ${bodyRows}
      ${ctaRow}
      ${panelRows}
      ${noteRow}

      <tr><td style="padding:30px 32px 0;"><div style="height:1px;background:${C.line};line-height:1px;font-size:0;">&nbsp;</div></td></tr>

      <tr><td align="center" bgcolor="${C.footer}" style="background:${C.footer};padding:18px 28px 24px;">
        <div style="font:700 13px/1.5 ${FONT};color:${C.heading};padding-bottom:5px;">
          Securely hosted in ${esc(config.dataRegionShort)}
        </div>
        <div style="font:400 12px/1.6 ${FONT};color:${C.muted};">
          &copy; ${new Date().getFullYear()} ${brand}${legal ? ` · ${legal}` : ''}
        </div>
        <div style="font:400 12px/1.6 ${FONT};color:${C.faint};padding-top:2px;">
          This email was automatically generated on ${esc(sentStamp())}.
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Plain-text alternative. Spam filters penalise HTML-only mail, and some
 *  clients still show this instead. */
export function renderText({ heading, lines = [], cta, panels = [], note }) {
  const out = [heading.toUpperCase(), '='.repeat(heading.length), ''];
  out.push(...lines, '');
  if (cta) out.push(`${cta.label}:`, cta.url, '');
  for (const p of panels) out.push(`${p.label}: ${p.value}`);
  if (panels.length) out.push('');
  if (note) out.push(note.replace(/<[^>]+>/g, ''), '');
  out.push(
    '—',
    `Securely hosted in ${config.dataRegionShort}.`,
    `${config.brand.name}${config.brand.legalName ? ` · ${config.brand.legalName}` : ''}`,
    `Automatically generated on ${sentStamp()}.`
  );
  return out.join('\n');
}

export { C as EMAIL_COLORS, FONT as EMAIL_FONT };
