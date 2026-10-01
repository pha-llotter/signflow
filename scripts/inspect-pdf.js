/**
 * Dumps the text of each page of a PDF with its position, so certificate and
 * stamping layout can be checked without opening a viewer.
 *
 *   node scripts/inspect-pdf.js path/to/file.pdf
 */
import fs from 'node:fs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/inspect-pdf.js <file.pdf>'); process.exit(1); }

const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
console.log(`${file} — ${pdf.numPages} pages\n`);

for (let i = 1; i <= pdf.numPages; i++) {
  const page = await pdf.getPage(i);
  const { width, height } = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  console.log(`--- page ${i}  (${Math.round(width)} x ${Math.round(height)}) ---`);

  // Group items onto visual lines so the dump reads like the page looks.
  const lines = new Map();
  for (const item of content.items) {
    if (!item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const key = Math.round(y / 4) * 4;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ x: Math.round(item.transform[4]), str: item.str });
  }
  [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .forEach(([y, items]) => {
      const text = items.sort((a, b) => a.x - b.x).map((t) => t.str).join('').replace(/\s+/g, ' ').trim();
      console.log(`  y=${String(y).padStart(4)}  x=${String(items[0].x).padStart(4)}  ${text}`);
    });
  console.log('');
}
