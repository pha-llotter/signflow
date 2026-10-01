/**
 * Screenshots a running instance at a desktop and a phone width, and reports
 * the rendered logo size and whether the page scrolls sideways.
 *
 *   node scripts/shot.js <outDir> [url]
 */
import { chromium } from 'playwright-core';

const out = process.argv[2] || '.';
const url = process.argv[3] || 'http://localhost:3000/login';

const browser = await chromium.launch({ channel: 'msedge', headless: true });

for (const [name, width, height] of [['live-desktop', 1440, 900], ['live-mobile', 390, 844]]) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

  const m = await page.evaluate(() => {
    const img = document.querySelector('.brand img');
    const r = img?.getBoundingClientRect();
    return {
      logo: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : 'none',
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
  console.log(`${name.padEnd(14)} logo ${m.logo.padEnd(9)} scrollW ${m.scrollW}  clientW ${m.clientW}`);
  await page.close();
}

await browser.close();
