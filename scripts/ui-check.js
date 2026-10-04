/**
 * Drives the two pages the HTTP smoke test cannot reach — the field placer and
 * the signing page — in a real browser, and screenshots them.
 *
 * Uses the Edge already installed on the machine rather than downloading one.
 *
 *   node scripts/ui-check.js [outputDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = process.argv[2] || path.resolve(import.meta.dirname, '..', 'ui-check');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signflow-ui-'));
const PORT = 3997;
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
    p.drawText(i === 0 ? 'ICT Acceptable Usage Policy' : 'Acceptance and signature', {
      x: 56, y: 770, size: 19, font: bold, color: rgb(0.1, 0.2, 0.42) });
    p.drawText('Protea Heights Academy', { x: 56, y: 745, size: 11, font, color: rgb(0.4, 0.43, 0.48) });
    if (i === 1) {
      p.drawText('Signed:', { x: 56, y: 470, size: 10, font });
      p.drawText('Date:', { x: 56, y: 400, size: 10, font });
      p.drawText('Full name:', { x: 320, y: 470, size: 10, font });
    }
  }
  return Buffer.from(await pdf.save());
}

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'development', PORT: String(PORT), BASE_URL: BASE,
    STORAGE_DIR: TMP, DB_PATH: path.join(TMP, 'ui.db'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_KEY: crypto.randomBytes(32).toString('hex'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitUp(ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await fetch(`${BASE}/login`); return true; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  return false;
}

let browser;
let ok = false;

try {
  if (!(await waitUp())) throw new Error(`server never came up:\n${serverLog}`);

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  // This suite talks to 127.0.0.1, which browsers count as a secure context.
  // People reach the app over a plain-http LAN address, which is not — and
  // there secure-only APIs such as crypto.randomUUID simply do not exist. Taking
  // it away here keeps the placer honest about that; it once broke every drop.
  await ctx.addInitScript(() => { delete Crypto.prototype.randomUUID; });
  const page = await ctx.newPage();

  // Any uncaught console error in the placer or signing page is a failure —
  // those pages are almost entirely client-side.
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  console.log('\nSignFlow UI check\n');

  // --- register ------------------------------------------------------------
  await page.goto(`${BASE}/register`);
  await page.fill('#display_name', 'Luan Lötter');
  await page.fill('#org_name', 'Protea Heights Academy');
  await page.fill('#email', `ui-${Date.now()}@example.test`);
  await page.fill('#password', 'a-long-enough-password');
  // Scope to the form — the nav bar's "Sign out" is also a submit button.
  await page.click('form[action="/register"] button[type=submit]');
  // The founding account is the administrator and lands on the team page.
  await page.waitForURL('**/team');
  check('the founding account is created and is an administrator', page.url().endsWith('/team'));

  // Asserted on the navigation region rather than a specific bar, so moving the
  // chrome around does not look like a permissions regression.
  check('an administrator sees Team and Settings in the navigation',
    (await page.locator('nav a[href="/team"]').count()) >= 1 &&
    (await page.locator('nav a[href="/settings"]').count()) >= 1);

  await page.goto(`${BASE}/documents`);

  // --- responsive layout ---------------------------------------------------
  // The nav logo is a 440px asset shown at ~34px tall. If the stylesheet fails to
  // apply it renders at natural size and shoves the page sideways, which is
  // exactly the kind of break that looks fine in a unit test.
  for (const [label, width, height] of [['desktop', 1600, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    // /documents, not /login: this context is signed in, and /login would
    // redirect — measuring a page the test did not think it was on.
    await page.goto(`${BASE}/documents`);
    await page.waitForLoadState('networkidle');

    const m = await page.evaluate(() => {
      // Whichever brand mark is actually on screen: the sidebar's at desktop
      // width, the mobile bar's below it.
      const img = [...document.querySelectorAll('.side-brand img, .brand img')]
        .find((el) => el.getBoundingClientRect().height > 0);
      const ftr = document.querySelector('.siteftr');
      return {
        logoH: img ? Math.round(img.getBoundingClientRect().height) : -1,
        logoW: img ? Math.round(img.getBoundingClientRect().width) : -1,
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        footerBottom: ftr ? Math.round(ftr.getBoundingClientRect().bottom) : -1,
        viewportH: window.innerHeight,
      };
    });

    check(`${label}: nav logo is scaled down, not natural size`,
      m.logoH > 8 && m.logoH <= 40 && m.logoW <= 180, `${m.logoW}x${m.logoH}px`);
    check(`${label}: page does not scroll horizontally`,
      m.scrollW <= m.clientW + 1, `scrollWidth ${m.scrollW} vs clientWidth ${m.clientW}`);
    // On a page shorter than the viewport the footer must still reach the
    // bottom edge, or it floats with page background showing underneath it.
    check(`${label}: footer sits on the bottom edge, not floating`,
      m.footerBottom >= m.viewportH - 2, `footer bottom ${m.footerBottom}, viewport ${m.viewportH}`);
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  // --- the dropzone --------------------------------------------------------
  await page.goto(`${BASE}/documents/new`);
  const pdfBuffer = await makePdf();

  check('dropzone starts in its idle state',
    await page.locator('.dropzone [data-dz-idle]').isVisible() &&
    !(await page.locator('.dropzone [data-dz-file]').isVisible()));

  // Recipients wait for the PDF: the whole section is a disabled fieldset
  // until a file is chosen, however it is chosen.
  const recipientsLocked = () => page.evaluate(() => {
    const fs = document.getElementById('recipients-card');
    return fs.disabled && document.querySelector('input[name=recipient_name]').matches(':disabled');
  });
  const currentStep = () => page.evaluate(() => document.querySelector('.steps .step-current .step-label')?.textContent);
  check('recipients are locked until a document is added',
    (await recipientsLocked()) && (await page.locator('#recipients-card .lock-note').isVisible()));

  // Simulate a real drag-and-drop. Playwright cannot drag from the OS, so the
  // file is built inside the page and dispatched through a DataTransfer —
  // exactly the path a real drop takes.
  const dropFile = async (name, type, contentB64) => {
    await page.evaluate(
      async ({ name, type, contentB64 }) => {
        const bin = atob(contentB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], name, { type }));
        const zone = document.querySelector('[data-dropzone]');
        zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
        zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      },
      { name, type, contentB64 }
    );
    await page.waitForTimeout(120);
  };

  // A non-PDF must be refused with a reason, not silently swallowed.
  await dropFile('notes.txt', 'text/plain', Buffer.from('hello').toString('base64'));
  const rejected = await page.locator('[data-dz-error]').textContent();
  check('dropping a non-PDF is refused with a reason',
    /not a PDF/i.test(rejected || '') && !(await page.locator('[data-dz-file]').isVisible()),
    `error text: ${rejected}`);
  check('...and a rejected file leaves recipients locked', await recipientsLocked());

  await dropFile('ict-policy.pdf', 'application/pdf', pdfBuffer.toString('base64'));
  const shownName = await page.locator('[data-dz-name]').textContent();
  check('dropping a PDF fills the input and shows the file',
    shownName === 'ict-policy.pdf' && (await page.locator('[data-dz-file]').isVisible()),
    `showed "${shownName}"`);
  check('the dropped file reached the real form input',
    await page.evaluate(() => document.querySelector('#pdf-input').files.length === 1));
  check('dropping a PDF unlocks recipients and moves the steps on',
    !(await recipientsLocked()) && (await currentStep()) === 'Add recipients', `current step: ${await currentStep()}`);
  await page.locator('.card').first().screenshot({ path: path.join(OUT, '0-dropzone-filled.png') });

  await page.click('[data-dz-clear]');
  await page.waitForTimeout(100);
  check('Remove clears the file and restores the idle state',
    (await page.locator('[data-dz-idle]').isVisible()) &&
    (await page.evaluate(() => document.querySelector('#pdf-input').files.length === 0)));
  check('...and locks recipients again', (await recipientsLocked()) && (await currentStep()) === 'Upload document');

  // Reminders must fit inside the expiry: the form greys out intervals as long
  // as the time allowed to sign, and drops a choice that no longer fits.
  const reminderState = () => page.evaluate(() => {
    const sel = document.getElementById('reminder_days');
    return { value: sel.value, disabled: [...sel.options].filter((o) => o.disabled).map((o) => o.value).join(',') };
  });
  check('reminders default to every 3 days on a 30-day document', (await reminderState()).value === '3');
  await page.fill('#expires_in_days', '1');
  let rs = await reminderState();
  check('a 1-day expiry leaves only Off', rs.value === '0' && rs.disabled === '1,2,3,7', JSON.stringify(rs));
  await page.fill('#expires_in_days', '3');
  await page.selectOption('#reminder_days', '2');
  rs = await reminderState();
  check('a 3-day expiry allows every day or every 2 days', rs.value === '2' && rs.disabled === '3,7', JSON.stringify(rs));
  await page.fill('#expires_in_days', '2');
  rs = await reminderState();
  check('shortening the expiry drops a choice that no longer fits', rs.value === '1', JSON.stringify(rs));
  await page.fill('#expires_in_days', '30');

  // --- upload --------------------------------------------------------------
  await page.setInputFiles('input[type=file]', {
    name: 'ict-policy.pdf', mimeType: 'application/pdf', buffer: pdfBuffer,
  });
  await page.fill('#title', 'ICT Policy');
  await page.fill('input[name=recipient_email]', 'signer@example.test');
  await page.fill('input[name=recipient_name]', 'Luan Test');
  await page.click('form[action="/documents/new"] button[type=submit]');
  try {
    await page.waitForURL('**/prepare', { timeout: 15000 });
  } catch {
    const notice = await page.locator('.notice').first().textContent().catch(() => null);
    throw new Error(`upload did not reach the placer (url=${page.url()}) — ${notice || 'no message on the page'}`);
  }
  check('upload landed on the field placer', page.url().includes('/prepare'));

  // --- the placer ----------------------------------------------------------
  // Pages are appended one at a time as each finishes rendering, so waiting for
  // the first canvas and then counting is a race — wait for the whole set.
  await page.waitForFunction(
    () => document.querySelectorAll('.pdf-page.painted').length >= 2,
    null,
    { timeout: 20000 }
  );
  const pageCount = await page.locator('.pdf-page').count();
  check('PDF.js rendered both pages', pageCount === 2, `rendered ${pageCount}`);

  const canvasPainted = await page.evaluate(() => {
    const c = document.querySelector('.pdf-page canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, Math.min(c.height, 400)).data;
    // A blank canvas is uniform; real page content is not.
    for (let i = 0; i < d.length; i += 4) if (d[i] !== d[0] || d[i + 1] !== d[1]) return true;
    return false;
  });
  check('the page actually painted, not a blank canvas', canvasPainted);

  // HTML5 drag-and-drop needs the DataTransfer path, which Playwright's mouse
  // does not drive — dispatch the events directly instead.
  const dropViaEvents = async (type, pageIndex, relX, relY) => {
    await page.evaluate(
      ({ type, pageIndex, relX, relY }) => {
        const holder = document.querySelectorAll('.pdf-page')[pageIndex];
        const rect = holder.getBoundingClientRect();
        const dt = new DataTransfer();
        dt.setData('text/plain', type);
        holder.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true, cancelable: true, dataTransfer: dt,
            clientX: rect.left + rect.width * relX,
            clientY: rect.top + rect.height * relY,
          })
        );
      },
      { type, pageIndex, relX, relY }
    );
  };

  await dropViaEvents('signature', 1, 0.28, 0.45);
  await dropViaEvents('date_signed', 1, 0.28, 0.53);
  await dropViaEvents('name', 1, 0.66, 0.45);
  await dropViaEvents('stamp', 0, 0.72, 0.15);
  await page.waitForTimeout(200);

  const placed = await page.locator('.fld').count();
  check('four fields were placed on the page', placed === 4, `found ${placed}`);

  // Select one and confirm the inspector responds.
  await page.locator('.fld').first().click();
  await page.waitForTimeout(150);
  const inspectorVisible = await page.locator('#inspector-body').isVisible();
  check('inspector opens for the selected field', inspectorVisible);

  // Drag the first field and confirm it moved. Deltas are measured from the
  // grab point, not from the box edge — the two coincide when the field
  // happens to be twice the offset wide, which silently reads as "no movement".
  const before = await page.locator('.fld').first().boundingBox();
  const grabX = before.x + before.width / 2;
  const grabY = before.y + before.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX - 120, grabY + 80, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const after = await page.locator('.fld').first().boundingBox();
  check('a field can be dragged to a new position',
    Math.abs(after.x - before.x) > 40 && Math.abs(after.y - before.y) > 20,
    `moved ${Math.round(after.x - before.x)}, ${Math.round(after.y - before.y)} px`);

  // Alignment guides: bring the date's left edge within a few pixels of the
  // signature's, and it snaps into line with a guide drawn while dragging.
  // Deselect first: a selected field is raised above its neighbours, and the
  // signature moved above now overlaps the date.
  await page.click('#field-done');
  await page.locator('.fld[data-type="date_signed"]').scrollIntoViewIfNeeded();
  const sigBox = await page.locator('.fld[data-type="signature"]').boundingBox();
  const dateBox = await page.locator('.fld[data-type="date_signed"]').boundingBox();
  const gx = dateBox.x + dateBox.width / 2, gy = dateBox.y + dateBox.height / 2;
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  await page.mouse.move(gx + (sigBox.x - dateBox.x) + 3, gy + 7, { steps: 8 });
  const guides = await page.locator('.align-guide.align-v').count();
  await page.mouse.up();
  await page.waitForTimeout(100);
  const lined = await page.locator('.fld[data-type="date_signed"]').boundingBox();
  check('dragging near another field\'s edge shows an alignment guide', guides === 1, `guides ${guides}`);
  check('...and snaps the edges into line', Math.abs(lined.x - sigBox.x) < 1, `${lined.x} vs ${sigBox.x}`);
  check('the guide goes away once the field is dropped', (await page.locator('.align-guide').count()) === 0);

  // The right column: the selected field's settings, or the pages when nothing is.
  await page.click('#field-done');
  await page.waitForTimeout(150);
  const thumbCount = await page.locator('#thumbs .thumb').count();
  check('with nothing selected, the right column shows a thumbnail of every page',
    (await page.locator('#pages-panel').isVisible()) && thumbCount === (await page.locator('.pdf-page').count()), `thumbs ${thumbCount}`);
  check('...marking where the fields are', (await page.locator('#thumbs .thumb-mark').count()) === (await page.locator('.fld').count()));
  await page.locator('#thumbs .thumb').nth(1).click();
  await page.waitForTimeout(700);
  check('clicking a thumbnail goes to that page', await page.locator('#thumbs .thumb').nth(1).evaluate((n) => n.classList.contains('current')));

  // Zoom: in, then Fit back.
  const fitWidth = (await page.locator('.pdf-page').first().boundingBox()).width;
  const fitLabel = await page.locator('#zoom-label').innerText();
  await page.click('#zoom-in');
  await page.waitForTimeout(300);
  const zoomedWidth = (await page.locator('.pdf-page').first().boundingBox()).width;
  check('zoom in enlarges the page and updates the percentage',
    zoomedWidth > fitWidth * 1.05 && (await page.locator('#zoom-label').innerText()) !== fitLabel, `${fitWidth} → ${zoomedWidth}`);
  check('...and fields stay where they were on the page', await page.evaluate(() => {
    const f = document.querySelector('.fld'), p = f.closest('.pdf-page');
    return Math.abs(f.offsetLeft / p.offsetWidth - parseFloat(f.style.left) / 100) < 0.01;
  }));
  await page.click('#zoom-fit');
  await page.waitForTimeout(300);
  check('Fit returns the page to the window', Math.abs((await page.locator('.pdf-page').first().boundingBox()).width - fitWidth) < 2
    && (await page.locator('#zoom-fit.on').count()) === 1);

  await page.click('#save-btn');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved', null, { timeout: 8000 });
  check('fields autosaved to the server', true);

  // In a window under ~1040px the palette is a drawer over a scrim. A mouse
  // drag from it used to drop onto the scrim and vanish — a desktop window
  // that is not maximised, or zoomed, is that narrow. Raw mouse events, so
  // nothing about the overlay is skipped the way a person would not skip it.
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(400);
  await page.evaluate(() => document.getElementById('canvas-area').scrollTo(0, 0));
  await page.click('#toggle-palette');
  await page.waitForTimeout(300);
  const fieldsBefore = await page.locator('.fld').count();
  const chipBox = await page.locator('.chip[data-type="name"]').boundingBox();
  const pageBox = await page.locator('.pdf-page').first().boundingBox();
  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + pageBox.width * 0.6, pageBox.y + pageBox.height * 0.2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check('a mouse drag from the drawer palette places a field in a narrow window',
    (await page.locator('.fld').count()) === fieldsBefore + 1,
    `${fieldsBefore} → ${await page.locator('.fld').count()}`);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);
  await page.click('#save-btn');
  await page.waitForFunction(() => document.getElementById('save-state').textContent === 'All changes saved', null, { timeout: 8000 });

  await page.screenshot({ path: path.join(OUT, '1-placer.png'), fullPage: false });

  // --- send ----------------------------------------------------------------
  await page.click('#send-btn');
  await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 10000 });
  check('sending redirected to the document page', true);
  await page.screenshot({ path: path.join(OUT, '2-document.png'), fullPage: true });

  const signLink = await page.evaluate(() =>
    document.querySelector('.copy-link')?.dataset.link || null);
  check('a signing link is offered to copy', !!signLink);

  // --- the signing page ----------------------------------------------------
  const signerCtx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const signPage = await signerCtx.newPage();
  const signErrors = [];
  signPage.on('console', (m) => { if (m.type() === 'error') signErrors.push(m.text()); });
  signPage.on('pageerror', (e) => signErrors.push(`pageerror: ${e.message}`));

  await signPage.goto(signLink);
  await signPage.waitForSelector('.pdf-page canvas', { timeout: 20000 });
  await signPage.waitForTimeout(400);

  const fillable = await signPage.locator('.sfld.mine').count();
  check('signer sees their own fields as fillable', fillable >= 1, `found ${fillable}`);

  // Consent comes first, in a welcome popup that covers the document.
  check('a welcome popup greets the signer, with the terms and consent',
    (await signPage.locator('#welcome').isVisible()) && /Before you sign/.test(await signPage.locator('#welcome').innerText()));
  check('Continue waits for consent', await signPage.locator('#welcome-continue').isDisabled());
  await signPage.screenshot({ path: path.join(OUT, '2b-welcome.png') });
  await signPage.check('#consent');
  await signPage.click('#welcome-continue');
  await signPage.waitForTimeout(300);
  check('after consenting, the document has the whole page', (await signPage.locator('#welcome').count()) === 0
    && !(await signPage.locator('.sign-side').count()));
  check('Finish is disabled until the required fields are done', await signPage.locator('#finish-btn').isDisabled());
  await signPage.waitForSelector('#sign-thumbs .thumb-mark.todo', { timeout: 5000 }).catch(() => {});
  check('the signer sees the pages beside the document, with their fields still to do marked',
    (await signPage.locator('#sign-thumbs .thumb').count()) === (await signPage.locator('.pdf-page').count())
    && (await signPage.locator('#sign-thumbs .thumb-mark.todo').count()) >= 1);
  await signPage.click('#next-btn');
  await signPage.waitForTimeout(200);
  check('Next field takes the signer to the field to fill', (await signPage.locator('.sfld.mine.pulse').count()) === 1);

  // Draw a signature.
  await signPage.locator('.sfld.mine').first().click();
  await signPage.waitForSelector('.modal', { timeout: 5000 });
  check('the signature pad opens', await signPage.locator('#sp-canvas').isVisible());

  const pad = await signPage.locator('#sp-canvas').boundingBox();
  await signPage.mouse.move(pad.x + 40, pad.y + 110);
  await signPage.mouse.down();
  let x = pad.x + 40;
  const y = pad.y + 110;
  for (const dy of [-45, 40, -55, 25, -30, 35]) {
    x += 38;
    await signPage.mouse.move(x, y + dy, { steps: 6 });
  }
  await signPage.mouse.up();

  await signPage.screenshot({ path: path.join(OUT, '3-signature-pad.png') });

  // Whatever is drawn here is stamped into a white PDF, so the pad must stay
  // light-on-paper in dark mode too — a pale stroke captured against a dark
  // pad would be invisible in the sealed document.
  await signPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await signPage.waitForTimeout(150);
  const padStyle = await signPage.evaluate(() => {
    const el = document.querySelector('.pad-wrap');
    const bg = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number);
    return { bg, luminance: (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 };
  });
  check('signature pad stays white paper in dark mode', padStyle.luminance > 0.9,
    `rgb(${padStyle.bg.join(',')}) luminance ${padStyle.luminance.toFixed(2)}`);
  await signPage.screenshot({ path: path.join(OUT, '3b-signature-pad-dark.png') });
  await signPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));

  await signPage.click('#sp-ok');
  await signPage.waitForTimeout(300);

  const applied = await signPage.locator('.sfld.mine.done img').count();
  check('the drawn signature was applied to the field', applied >= 1, `found ${applied}`);

  const canFinish = !(await signPage.locator('#finish-btn').isDisabled());
  check('Finish enables once the required fields are done', canFinish);

  await signPage.screenshot({ path: path.join(OUT, '4-signing.png'), fullPage: false });

  if (canFinish) {
    await signPage.click('#finish-btn');
    await signPage.waitForSelector('.modal', { timeout: 5000 });
    check('Finish asks for confirmation before anything is signed',
      /cannot be changed/.test(await signPage.locator('.modal').innerText()) && !signPage.url().endsWith('/done'));
    await signPage.screenshot({ path: path.join(OUT, '4b-confirm.png') });
    await signPage.click('.modal #m-ok');
    await signPage.waitForURL('**/done', { timeout: 20000 });
    check('signing completed and sealed', true);
    await signPage.screenshot({ path: path.join(OUT, '5-done.png'), fullPage: true });

    await signPage.goto(`${BASE}/verify`);
    await signPage.screenshot({ path: path.join(OUT, '6-verify.png'), fullPage: true });
  }

  check('no console errors on the placer', consoleErrors.length === 0, consoleErrors.join('\n          '));
  check('no console errors on the signing page', signErrors.length === 0, signErrors.join('\n          '));

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`screenshots → ${OUT}\n`);
  ok = failed === 0;
} catch (err) {
  console.error('\nUI check crashed:', err.message);
  if (serverLog) console.error('\n--- server output ---\n' + serverLog);
} finally {
  await browser?.close();
  server.kill();
  await new Promise((r) => (server.exitCode === null ? server.once('exit', r) : r()));
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); } catch {}
}

process.exit(ok ? 0 : 1);
