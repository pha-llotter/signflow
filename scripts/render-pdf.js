/**
 * Renders PDF pages to PNGs using PDF.js in headless Edge, so seal and
 * certificate layout can actually be looked at rather than inferred from a
 * text dump. No poppler or ImageMagick needed.
 *
 *   node scripts/render-pdf.js <file.pdf> <outDir> [scale] [crop]
 *
 * crop is "page,x,y,w,h" in page fractions, e.g. "2,0.12,0.36,0.42,0.16"
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';

const [file, outDir, scaleArg, cropArg] = process.argv.slice(2);
if (!file || !outDir) {
  console.error('usage: node scripts/render-pdf.js <file.pdf> <outDir> [scale] [crop]');
  process.exit(1);
}
const scale = Number(scaleArg) || 2;
fs.mkdirSync(outDir, { recursive: true });

const pdfjs = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'node_modules/pdfjs-dist/build/pdf.min.mjs'), 'utf8');
const worker = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8');
const data = fs.readFileSync(file).toString('base64');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

// Serve the library and worker from the page's own origin so the module and
// its worker are same-origin — PDF.js will not load a worker cross-origin.
await page.route('**/pdf.min.mjs', (r) => r.fulfill({ body: pdfjs, contentType: 'text/javascript' }));
await page.route('**/pdf.worker.min.mjs', (r) => r.fulfill({ body: worker, contentType: 'text/javascript' }));
await page.route('**/render.html', (r) =>
  r.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><div id="out"></div></body>' })
);
await page.goto('https://render.local/render.html');

const count = await page.evaluate(
  async ({ data, scale }) => {
    const pdfjsLib = await import('/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const out = document.getElementById('out');
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const viewport = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.id = `page-${i}`;
      canvas.style.display = 'block';
      out.appendChild(canvas);
      await p.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    return pdf.numPages;
  },
  { data, scale }
);

for (let i = 1; i <= count; i++) {
  await page.locator(`#page-${i}`).screenshot({ path: path.join(outDir, `page-${i}.png`) });
}

if (cropArg) {
  // Crop the saved page image rather than clipping a viewport screenshot: a
  // page rendered at scale 3 is far taller than any viewport, so the clip
  // rectangle for anything below the fold falls outside the captured area.
  const [pg, cx, cy, cw, ch] = cropArg.split(',').map(Number);
  const src = PNG.sync.read(fs.readFileSync(path.join(outDir, `page-${pg}.png`)));

  const x = Math.max(0, Math.round(src.width * cx));
  const y = Math.max(0, Math.round(src.height * cy));
  const w = Math.min(src.width - x, Math.round(src.width * cw));
  const h = Math.min(src.height - y, Math.round(src.height * ch));

  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    src.data.copy(out.data, row * w * 4, ((y + row) * src.width + x) * 4, ((y + row) * src.width + x + w) * 4);
  }
  const file = path.join(outDir, 'crop.png');
  fs.writeFileSync(file, PNG.sync.write(out));
  console.log(`crop ${w}x${h} → ${file}`);
}

console.log(`${count} page(s) → ${outDir}`);
await browser.close();
