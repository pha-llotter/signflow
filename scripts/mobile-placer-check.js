/**
 * Can you actually place a signing field on a phone?
 *
 *   node scripts/mobile-placer-check.js [outDir]
 *
 * Emulated iPhone: touch events only, no mouse, no hover. HTML5 drag-and-drop
 * does not exist here, so the tap-to-place path is the only way in — and the
 * page has to be small enough to see where you are tapping.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = process.argv[2] || path.resolve(import.meta.dirname, '..', 'mobile-check');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signflow-mob-'));
const PORT = 3992;
const BASE = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? `\n          ${extra}` : ''}`); }
};

async function makePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < 2; i++) {
    const p = pdf.addPage([595.28, 841.89]);
    p.drawText(i === 0 ? 'ICT Acceptable Usage Policy' : 'Acceptance', {
      x: 56, y: 770, size: 19, font: bold, color: rgb(0.1, 0.2, 0.42) });
    if (i === 1) p.drawText('Signed:', { x: 56, y: 470, size: 10, font });
  }
  return Buffer.from(await pdf.save());
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), BASE_URL: BASE,
    STORAGE_DIR: TMP, DB_PATH: path.join(TMP, 'm.db'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_KEY: crypto.randomBytes(32).toString('hex'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let browser;
let ok = false;
try {
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${BASE}/login`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  console.log('\nMobile field placer check (iPhone 13, touch only)\n');

  await page.goto(`${BASE}/register`);
  await page.fill('#display_name', 'Mobile Admin');
  await page.fill('#email', `mob-${Date.now()}@example.test`);
  await page.fill('#password', 'a-long-enough-password');
  await page.tap('form[action="/register"] button[type=submit]');
  await page.waitForURL('**/team');

  // --- the sidebar drawer --------------------------------------------------
  await page.goto(`${BASE}/documents`);
  check('the sidebar is tucked away on a phone',
    !(await page.locator('.sidebar').evaluate((n) => n.classList.contains('open'))) &&
    (await page.locator('#sidebar-toggle').isVisible()));

  await page.tap('#sidebar-toggle');
  await page.waitForTimeout(320);
  const openedOn = await page.locator('.sidebar').evaluate((n) => Math.round(n.getBoundingClientRect().left));
  check('tapping the menu slides the sidebar in', openedOn >= -2, `sidebar left edge at ${openedOn}px`);
  check('navigation is reachable from the drawer',
    (await page.locator('.sidebar a[href="/team"]').isVisible()) &&
    (await page.locator('.sidebar a[href="/settings"]').isVisible()));

  // Tap the exposed strip beside the open drawer, not the scrim's centre —
  // its centre is underneath the drawer, which is where a real thumb would
  // never land anyway.
  const vw = page.viewportSize().width;
  const barRight = await page.locator('.sidebar').evaluate((n) => n.getBoundingClientRect().right);
  check('enough of the page is left exposed to tap out of the drawer',
    vw - barRight > 60, `only ${Math.round(vw - barRight)}px exposed`);
  await page.touchscreen.tap(barRight + (vw - barRight) / 2, 400);
  await page.waitForTimeout(320);
  check('tapping outside closes the drawer again',
    (await page.locator('.sidebar').evaluate((n) => Math.round(n.getBoundingClientRect().right))) < 2);

  await page.goto(`${BASE}/documents/new`);
  await page.setInputFiles('input[type=file]', {
    name: 'policy.pdf', mimeType: 'application/pdf', buffer: await makePdf(),
  });
  await page.fill('#title', 'ICT Policy');
  await page.fill('input[name=recipient_name]', 'Luan Test');
  await page.fill('input[name=recipient_email]', 'signer@example.test');
  await page.tap('form[action="/documents/new"] button[type=submit]');
  await page.waitForURL('**/prepare');

  await page.waitForFunction(() => document.querySelectorAll('.pdf-page canvas').length >= 2, null, { timeout: 25000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '1-placer-mobile.png') });

  // --- can you see the page you are placing on? ----------------------------
  const fit = await page.evaluate(() => {
    const holder = document.querySelector('.pdf-page');
    const area = document.querySelector('.canvas-area');
    return {
      pageWidth: Math.round(holder.getBoundingClientRect().width),
      areaWidth: Math.round(area.clientWidth),
      viewport: document.documentElement.clientWidth,
      areaScrollWidth: area.scrollWidth,
    };
  });
  check('the page fits the screen without sideways scrolling',
    fit.pageWidth <= fit.areaWidth + 1,
    `page ${fit.pageWidth}px inside a ${fit.areaWidth}px column on a ${fit.viewport}px screen`);

  // --- does the screen say what to do? -------------------------------------
  // Someone opening this for the first time on a phone should not have to guess
  // the interaction; if they do, the feature may as well not exist.
  const emptyHint = await page.locator('#placer-empty').textContent().catch(() => '');
  check('an empty document explains how to add a field',
    await page.locator('#placer-empty').isVisible(),
    'no empty-state guidance shown');
  check('the guidance names the button that actually opens the palette',
    /Add field/i.test(emptyHint || ''), (emptyHint || '').trim().slice(0, 120));

  // --- is the palette reachable? -------------------------------------------
  const paletteVisible = await page.locator('.palette').isVisible();
  const toggleVisible = await page.locator('#toggle-palette').isVisible();
  check('there is a way to open the field palette', toggleVisible || paletteVisible,
    `toggle ${toggleVisible}, palette ${paletteVisible}`);

  if (toggleVisible) {
    await page.tap('#toggle-palette');
    await page.waitForTimeout(300);
    check('tapping Fields opens the palette', await page.locator('.palette').isVisible());
  }

  // --- tap to arm ----------------------------------------------------------
  await page.tap('.chip[data-type="signature"]');
  await page.waitForTimeout(300);
  const armed = await page.locator('.chip[data-type="signature"].armed').count();
  check('tapping a field type arms it', armed === 1, `armed count ${armed}`);

  const bannerText = await page.locator('#banner-text').textContent().catch(() => '');
  check('a banner over the document says to tap where it should go',
    (await page.locator('#placer-banner').isVisible()) && /tap the page/i.test(bannerText || ''),
    `banner: "${(bannerText || '').trim()}"`);
  await page.screenshot({ path: path.join(OUT, '2-armed.png') });

  // Arming by mistake must be escapable without placing something unwanted.
  await page.tap('#banner-cancel');
  await page.waitForTimeout(200);
  check('Cancel disarms without placing anything',
    (await page.locator('.chip.armed').count()) === 0 &&
    (await page.locator('.fld').count()) === 0);

  await page.tap('#toggle-palette');
  await page.waitForTimeout(300);
  await page.tap('.chip[data-type="signature"]');
  await page.waitForTimeout(300);

  /**
   * A real finger swipe, driven through CDP.
   *
   * Dispatching TouchEvent objects from page script does not work here: they
   * fire listeners but never trigger the browser's own behaviour, so the page
   * would not actually scroll and the test would prove nothing. CDP input is
   * the real thing — it scrolls, and it produces genuine pointer events.
   *
   * This distinction is the whole bug: Playwright's tap() sends down and up at
   * one point, so placing on pointerdown passed every test and failed on a real
   * phone the moment anyone swiped.
   */
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (x, y, dx, dy, steps = 10) => {
    const point = (px, py) => [{ x: px, y: py, radiusX: 12, radiusY: 12, force: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(x + (dx * i) / steps, y + (dy * i) / steps),
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(350);
  };

  // --- a swipe while armed must scroll, not place --------------------------
  const area = page.locator('.canvas-area');
  const areaBox = await area.boundingBox();

  const geom = await page.evaluate(() => {
    const a = document.querySelector('.canvas-area');
    const cs = getComputedStyle(a);
    return {
      clientH: a.clientHeight, scrollH: a.scrollHeight,
      overflowY: cs.overflowY, touchAction: cs.touchAction,
      bodyOverflow: getComputedStyle(document.body).overflow,
      viewportH: window.innerHeight,
    };
  });
  check('the document column is actually scrollable',
    geom.scrollH > geom.clientH + 4,
    `content ${geom.scrollH}px in a ${geom.clientH}px column (overflow-y ${geom.overflowY}, body ${geom.bodyOverflow}, viewport ${geom.viewportH})`);

  const beforeScroll = await area.evaluate((n) => n.scrollTop);

  await swipe(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height * 0.7, 0, -220);

  const afterScroll = await area.evaluate((n) => n.scrollTop);
  check('the document still scrolls while a field type is armed',
    afterScroll > beforeScroll, `scrollTop ${beforeScroll} → ${afterScroll}`);
  check('swiping does not drop a field where the swipe started',
    (await page.locator('.fld').count()) === 0,
    `${await page.locator('.fld').count()} field(s) placed by a scroll`);
  check('the field type stays armed after a scroll',
    (await page.locator('.chip.armed').count()) === 1);

  // --- tap the page to place ----------------------------------------------
  const target = page.locator('.pdf-page').nth(1);
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const box = await target.boundingBox();
  await page.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.waitForTimeout(400);

  const placed = await page.locator('.fld').count();
  check('tapping the page places the field', placed === 1, `found ${placed} field(s)`);
  await page.screenshot({ path: path.join(OUT, '3-placed.png') });

  /**
   * Placement must depend on `click` and nothing else.
   *
   * Inside a scrollable container mobile browsers routinely fire
   * `pointercancel` instead of `pointerup`, which silently swallows a tap if
   * placement is hung off the pointer stream — the emulator does not reproduce
   * that, so assert the contract directly: a bare click, with no pointer events
   * at all, has to be enough.
   */
  await page.tap('#toggle-palette');
  await page.waitForTimeout(300);
  await page.tap('.chip[data-type="date_signed"]');
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const holder = document.querySelectorAll('.pdf-page')[1];
    const r = holder.getBoundingClientRect();
    holder.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
      clientX: r.left + r.width * 0.65, clientY: r.top + r.height * 0.3,
    }));
  });
  await page.waitForTimeout(300);
  check('a bare click places a field, with no pointer events involved',
    (await page.locator('.fld').count()) === 2,
    `${await page.locator('.fld').count()} field(s) — placement still depends on the pointer stream`);

  // --- and scrolling still works once a field is on the page ---------------
  const scrollBefore = await area.evaluate((n) => n.scrollTop);
  await swipe(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height * 0.7, 0, -200);
  const scrollAfter = await area.evaluate((n) => n.scrollTop);
  check('scrolling is not stuck after placing a field',
    scrollAfter !== scrollBefore, `scrollTop ${scrollBefore} → ${scrollAfter}`);

  // --- can you move it? ----------------------------------------------------
  if (placed === 1) {
    const before = await page.locator('.fld').first().boundingBox();
    await page.touchscreen.tap(before.x + before.width / 2, before.y + before.height / 2);
    await page.waitForTimeout(200);

    // A touch drag: down, move, up.
    await page.locator('.fld').first().hover().catch(() => {});
    await page.evaluate(({ x, y, dx, dy }) => {
      const node = document.querySelector('.fld');
      const opts = (cx, cy) => ({ bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: cx, clientY: cy, isPrimary: true });
      node.dispatchEvent(new PointerEvent('pointerdown', opts(x, y)));
      node.dispatchEvent(new PointerEvent('pointermove', opts(x + dx, y + dy)));
      node.dispatchEvent(new PointerEvent('pointerup', opts(x + dx, y + dy)));
    }, { x: before.x + before.width / 2, y: before.y + before.height / 2, dx: -50, dy: 60 });
    await page.waitForTimeout(300);

    const after = await page.locator('.fld').first().boundingBox();
    check('a placed field can be dragged by touch',
      Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10,
      `moved ${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)} px`);
  }

  // --- does it save? -------------------------------------------------------
  // The explicit Save button is hidden on a phone, so autosave has to be what
  // actually persists the layout.
  const saved = await page
    .waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved', null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check('autosave persists the layout without a Save button', saved);

  const persisted = await page.evaluate(async (id) => {
    const res = await fetch(`/documents/${id}/prepare`);
    return (await res.text()).includes('"type":"signature"');
  }, page.url().match(/documents\/([0-9a-f-]{36})/)[1]);
  check('the field is still there when the page is reloaded', persisted);

  // The toolbar must not eat the screen it is there to help you work on.
  const barShare = await page.evaluate(() => {
    const bar = document.querySelector('.placer-bar');
    return bar.getBoundingClientRect().height / window.innerHeight;
  });
  check('the toolbar leaves most of the screen for the document',
    barShare < 0.2, `toolbar takes ${Math.round(barShare * 100)}% of the viewport`);

  check('no console errors on the placer', errors.length === 0, errors.join('\n          '));

  /* ---------------------------------------------------------------- signing */
  // Most signers are on a phone, so this page matters more than the editor.
  await page.tap('#send-btn');
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 15000 });
  const signLink = await page.evaluate(() => document.querySelector('.copy-link')?.dataset.link);
  check('a signing link is issued', !!signLink);

  const signCtx = await browser.newContext({ ...devices['iPhone 13'] });
  const sign = await signCtx.newPage();
  const signErrors = [];
  sign.on('pageerror', (e) => signErrors.push(e.message));
  sign.on('console', (m) => { if (m.type() === 'error') signErrors.push(m.text()); });

  await sign.goto(signLink);
  await sign.waitForSelector('.pdf-page canvas', { timeout: 25000 });
  await sign.waitForTimeout(500);
  await sign.screenshot({ path: path.join(OUT, '4-sign-mobile.png') });

  const signGeom = await sign.evaluate(() => {
    const doc = document.documentElement;
    return { scrollH: doc.scrollHeight, clientH: doc.clientHeight, bodyOverflow: getComputedStyle(document.body).overflow };
  });
  check('the signing page can be scrolled to reach the whole document',
    signGeom.scrollH > signGeom.clientH + 4,
    `content ${signGeom.scrollH}px in ${signGeom.clientH}px (body overflow ${signGeom.bodyOverflow})`);

  const signCdp = await signCtx.newCDPSession(sign);
  const before = await sign.evaluate(() => window.scrollY);
  const p = (px, py) => [{ x: px, y: py, radiusX: 12, radiusY: 12, force: 1 }];
  await signCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(195, 500) });
  for (let i = 1; i <= 10; i++) {
    await signCdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(195, 500 - i * 25) });
    await sign.waitForTimeout(16);
  }
  await signCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sign.waitForTimeout(400);
  check('swiping scrolls the signing page',
    (await sign.evaluate(() => window.scrollY)) > before,
    `scrollY ${before} → ${await sign.evaluate(() => window.scrollY)}`);

  check('the bottom sheet shows progress without covering the document',
    await sign.locator('#sheet-toggle').isVisible());

  await sign.locator('.sfld.mine').first().scrollIntoViewIfNeeded();
  await sign.waitForTimeout(200);
  await sign.locator('.sfld.mine').first().tap();
  await sign.waitForSelector('.modal', { timeout: 6000 });
  check('tapping a field opens the signature pad on a phone',
    await sign.locator('#sp-canvas').isVisible());

  // Draw with a finger.
  const pad = await sign.locator('#sp-canvas').boundingBox();
  const padCdp = signCdp;
  await padCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(pad.x + 30, pad.y + pad.height / 2) });
  for (let i = 1; i <= 10; i++) {
    await padCdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: p(pad.x + 30 + i * 20, pad.y + pad.height / 2 + (i % 2 ? -25 : 25)),
    });
    await sign.waitForTimeout(16);
  }
  await padCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sign.waitForTimeout(200);
  await sign.screenshot({ path: path.join(OUT, '5-sign-pad-mobile.png') });

  // A synthetic tap on the dialog's button occasionally fails to land — the
  // dialog is simply still open afterwards. A person taps again; so does this,
  // once, rather than reporting a missed tap as a lost signature. When the tap
  // lands, the signature is on the field within a few milliseconds.
  await sign.tap('#sp-ok');
  if (!(await sign.waitForSelector('.modal', { state: 'detached', timeout: 1500 }).then(() => true).catch(() => false))) {
    await sign.tap('#sp-ok');
  }
  await sign.waitForTimeout(400);
  check('a finger-drawn signature is captured',
    (await sign.locator('.sfld.mine.done img').count()) >= 1);

  // The sheet raises itself once every required field is done, so toggling
  // blindly here would close it again.
  const sheetAlreadyUp = await sign.evaluate(() =>
    document.getElementById('sign-side').classList.contains('open'));
  check('the sheet raises itself once the fields are complete', sheetAlreadyUp);
  if (!sheetAlreadyUp) await sign.tap('#sheet-toggle');
  await sign.waitForTimeout(350);
  await sign.locator('#consent').check();
  await sign.waitForTimeout(200);
  check('Finish enables once consent is given', !(await sign.locator('#finish-btn').isDisabled()));

  await sign.tap('#finish-btn');
  await sign.waitForURL('**/done', { timeout: 25000 });
  check('a document can be signed end to end from a phone', true);
  await sign.screenshot({ path: path.join(OUT, '6-sign-done-mobile.png') });

  check('no console errors on the signing page', signErrors.length === 0, signErrors.join('\n          '));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`screenshots → ${OUT}\n`);
  ok = failed === 0;
} catch (err) {
  console.error('\nmobile check crashed:', err.message);
  if (log) console.error('\n--- server output ---\n' + log);
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => (server.exitCode === null ? server.once('exit', r) : r()));
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); } catch {}
}

process.exit(ok ? 0 : 1);
