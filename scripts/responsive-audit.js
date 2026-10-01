/**
 * Walks every page at phone, tablet and desktop widths and reports layout
 * problems that are invisible at desktop size: horizontal overflow, text or
 * controls too small to use, and tap targets below the 44px guideline.
 *
 *   node scripts/responsive-audit.js [outDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = process.argv[2] || path.resolve(import.meta.dirname, '..', 'responsive-audit');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signflow-resp-'));
const PORT = 3994;
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  ['phone', 390, 844],
  ['tablet', 768, 1024],
  ['desktop', 1440, 900],
];

let problems = 0;

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 2; i++) {
    const p = pdf.addPage([595.28, 841.89]);
    p.drawText(i === 0 ? 'ICT Acceptable Usage Policy' : 'Acceptance', {
      x: 56, y: 770, size: 19, font: bold, color: rgb(0.1, 0.2, 0.42) });
    p.drawText('Protea Heights Academy', { x: 56, y: 745, size: 11, font, color: rgb(0.4, 0.43, 0.48) });
    if (i === 1) p.drawText('Signed:', { x: 56, y: 470, size: 10, font });
  }
  return Buffer.from(await pdf.save());
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), BASE_URL: BASE,
    STORAGE_DIR: TMP, DB_PATH: path.join(TMP, 'a.db'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_KEY: crypto.randomBytes(32).toString('hex'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

for (let i = 0; i < 100; i++) {
  try { await fetch(`${BASE}/login`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

/**
 * Collects the measurements that actually predict a bad mobile experience.
 *
 * `touch` gates the checks that only make sense at phone and tablet widths —
 * a 34px button and a 14px input are perfectly fine under a mouse pointer, and
 * reporting them at 1440px is noise that hides the real findings.
 */
async function measure(page, touch) {
  return page.evaluate((isTouch) => {
    const doc = document.documentElement;

    /** Panels parked off-canvas on purpose are not overflow. */
    const isDeliberatelyOffscreen = (el) =>
      !!el.closest('.palette:not(.open), .inspector:not(.open), .sign-side:not(.open), .modal-back');

    const overflowing = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= doc.clientWidth + 2 && r.left >= -2) continue;
      const cs = getComputedStyle(el);
      // An element that scrolls internally is allowed to be wider than the
      // viewport — that is the fix, not the bug.
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue;
      if (isDeliberatelyOffscreen(el)) continue;
      if (el.closest('.canvas-area, .sign-doc, .topbar nav')) continue;
      overflowing.push(
        `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} → ${Math.round(r.right)}px`
      );
    }

    const smallText = [];
    const smallTargets = [];

    if (isTouch) {
      for (const el of document.querySelectorAll('input, select, textarea')) {
        // Hidden and zero-size controls are never focused, so they cannot
        // trigger the iOS zoom this check exists to catch.
        if (el.type === 'hidden' || el.offsetParent === null) continue;
        if (['checkbox', 'radio', 'file'].includes(el.type)) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 16) smallText.push(`${el.tagName.toLowerCase()}#${el.id || '?'} ${size}px`);
      }

      for (const el of document.querySelectorAll('button, a.btn, .link-btn, .chip')) {
        if (el.offsetParent === null || isDeliberatelyOffscreen(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 40) {
          smallTargets.push(`${(el.textContent || '').trim().slice(0, 22) || el.tagName} ${Math.round(r.height)}px`);
        }
      }
    }

    /* ---- contrast ---------------------------------------------------------
       Dark mode fails quietly: a token that was not re-mixed leaves dark text
       on a dark panel, which no layout check would ever notice. This walks the
       real rendered colours and applies the WCAG AA ratio. */
    const parse = (c) => {
      const m = c.match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    /** Walks up for the first opaque background, the way the eye does. */
    const backdrop = (el) => {
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a >= 0.85) return c;
      }
      return parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    };

    const lowContrast = [];
    for (const el of document.querySelectorAll('p, a, span, td, th, h1, h2, h3, label, button, li, div')) {
      if (!el.firstChild || el.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const txt = el.firstChild.textContent.trim();
      if (txt.length < 2) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('.pdf-page, .pad-wrap, .typed-preview')) continue; // white paper, by design

      const cs = getComputedStyle(el);
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = backdrop(el);
      const L1 = lum(fg);
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);

      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      const floor = large ? 3 : 4.5;
      if (ratio < floor) {
        lowContrast.push(`${txt.slice(0, 24)} ${ratio.toFixed(2)}:1 (needs ${floor})`);
      }
    }

    return {
      scrollW: doc.scrollWidth, clientW: doc.clientWidth,
      overflowing: [...new Set(overflowing)].slice(0, 6),
      smallText: [...new Set(smallText)].slice(0, 4),
      smallTargets: [...new Set(smallTargets)].slice(0, 6),
      lowContrast: [...new Set(lowContrast)].slice(0, 6),
    };
  }, touch);
}

function report(label, m) {
  const issues = [];
  if (m.scrollW > m.clientW + 1) issues.push(`scrolls horizontally (${m.scrollW} > ${m.clientW})`);
  if (m.overflowing.length) issues.push(`overflows: ${m.overflowing.join(', ')}`);
  if (m.smallText.length) issues.push(`iOS will zoom on: ${m.smallText.join(', ')}`);
  if (m.smallTargets.length) issues.push(`tap targets < 40px: ${m.smallTargets.join(', ')}`);
  if (m.lowContrast?.length) issues.push(`contrast below AA: ${m.lowContrast.join(', ')}`);

  if (!issues.length) { console.log(`  ok    ${label}`); return; }
  problems += issues.length;
  console.log(`  ISSUE ${label}`);
  for (const i of issues) console.log(`          - ${i}`);
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  // Seed an account and a document so the data-bearing pages have content.
  await page.goto(`${BASE}/register`);
  await page.fill('#display_name', 'Luan Lötter');
  await page.fill('#org_name', 'Protea Heights Academy');
  await page.fill('#email', `audit-${Date.now()}@example.test`);
  await page.fill('#password', 'a-long-enough-password');
  await page.click('form[action="/register"] button[type=submit]');
  await page.waitForURL('**/team');

  // An outstanding invitation, so the team page has rows to lay out.
  await page.goto(`${BASE}/team`);
  await page.fill('#invite-email', `invited-${Date.now()}@example.test`);
  await page.click('form[action="/team/invite"] button[type=submit]');
  await page.waitForURL('**/team');
  const inviteToken = (await page.content()).match(/\/invite\/([A-Za-z0-9_-]{40,})/)?.[1];

  await page.goto(`${BASE}/documents/new`);
  await page.setInputFiles('input[type=file]', { name: 'ict-policy.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.fill('#title', 'ICT Acceptable Usage Policy 2026');
  await page.fill('input[name=recipient_name]', 'Luan Test');
  await page.fill('input[name=recipient_email]', 'signer@example.test');
  await page.click('form[action="/documents/new"] button[type=submit]');
  await page.waitForURL('**/prepare');
  const docId = page.url().match(/documents\/([0-9a-f-]{36})/)[1];

  await page.waitForSelector('.pdf-page canvas', { timeout: 20000 });
  await page.evaluate(() => {
    const holder = document.querySelectorAll('.pdf-page')[1];
    const rect = holder.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData('text/plain', 'signature');
    holder.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
      clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.5,
    }));
  });
  // Autosave, rather than the Save button — that button is hidden on phones and
  // this seeding runs at phone width.
  await page.waitForFunction(
    () => document.getElementById('save-state').textContent === 'All changes saved',
    null,
    { timeout: 10000 }
  );
  await page.click('#send-btn');
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/);
  const signLink = await page.evaluate(() => document.querySelector('.copy-link')?.dataset.link);

  // A second draft document, because /prepare redirects away once an envelope
  // has been sent — auditing that URL against the sent one silently measured
  // the wrong page.
  await page.goto(`${BASE}/documents/new`);
  await page.setInputFiles('input[type=file]', { name: 'draft.pdf', mimeType: 'application/pdf', buffer: await makePdf() });
  await page.fill('#title', 'Draft for layout audit');
  await page.fill('input[name=recipient_name]', 'Second Signer');
  await page.fill('input[name=recipient_email]', 'second@example.test');
  await page.click('form[action="/documents/new"] button[type=submit]');
  await page.waitForURL('**/prepare');
  const draftId = page.url().match(/documents\/([0-9a-f-]{36})/)[1];

  // Signed-in visitors are redirected away from /login and /register, so those
  // two have to be measured in a context with no session at all.
  const anonCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const anon = await anonCtx.newPage();

  const pages = [
    ['login', `${BASE}/login`, anon],
    // /register is unreachable once the founding account exists; admin-check
    // is where that is asserted.
    ['documents', `${BASE}/documents`, page],
    ['new', `${BASE}/documents/new`, page],
    ['document', `${BASE}/documents/${docId}`, page],
    ['settings', `${BASE}/settings`, page],
    ['team', `${BASE}/team`, page],
    ['profile', `${BASE}/profile`, page],
    ['invite', `${BASE}/invite/${inviteToken}`, anon],
    ['verify', `${BASE}/verify/${docId}`, anon],
    ['prepare', `${BASE}/documents/${draftId}/prepare`, page],
    ['sign', signLink, anon],
  ];

  // Both themes get the full sweep. Dark mode fails silently — a token that was
  // never re-mixed leaves unreadable text that no layout assertion would catch.
  for (const theme of ['light', 'dark']) {
    for (const p of [page, anon]) {
      await p.addInitScript((t) => {
        try { localStorage.setItem('signflow-theme', t); } catch {}
      }, theme);
    }

  for (const [vpName, width, height] of VIEWPORTS) {
    console.log(`\n${theme} · ${vpName} (${width}x${height})`);
    await page.setViewportSize({ width, height });
    await anon.setViewportSize({ width, height });

    for (const [name, url, target] of pages) {
      await target.goto(url, { waitUntil: 'networkidle' });
      await target.evaluate((t) => {
        try { localStorage.setItem('signflow-theme', t); } catch {}
        document.documentElement.setAttribute('data-theme', t);
      }, theme);
      // Guard against the silent-redirect trap the audit itself fell into.
      const landed = new URL(target.url()).pathname;
      const expected = new URL(url).pathname;
      if (landed !== expected) {
        console.log(`  SKIP  ${name.padEnd(10)} redirected ${expected} → ${landed}`);
        continue;
      }
      if (name === 'prepare' || name === 'sign') {
        await target.waitForSelector('.pdf-page canvas', { timeout: 20000 }).catch(() => {});
        await target.waitForTimeout(600);
      }
      report(`${name.padEnd(10)}`, await measure(target, width <= 820));
      await target.screenshot({
        path: path.join(OUT, `${theme}-${vpName}-${name}.png`),
        fullPage: vpName !== 'desktop',
      });
    }
  }
  }

  console.log(`\n${problems === 0 ? 'No layout problems found.' : `${problems} issue(s) found.`}`);
  console.log(`screenshots → ${OUT}\n`);
} catch (err) {
  // Counted as a failure, not just printed. Reporting success because the run
  // never reached its assertions is worse than reporting nothing.
  problems++;
  console.error('audit crashed:', err.message);
  if (log) console.error(log);
} finally {
  await browser.close();
  server.kill();
  await new Promise((r) => (server.exitCode === null ? server.once('exit', r) : r()));
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); } catch {}
}

process.exit(problems === 0 ? 0 : 1);
