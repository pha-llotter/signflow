/**
 * Derives the brand assets the app actually ships from the full-resolution
 * source logo.
 *
 *   node scripts/build-brand.js [source.png]
 *
 * The source is ~790 KB at 2172x724. Serving that in a 28px-tall nav bar wastes
 * most of a megabyte, and embedding it in every sealed PDF would add the same
 * again to each document — so we emit right-sized copies once, here, rather
 * than shipping the original three times over.
 *
 *   logo-web.png    440px wide   nav bar, signing page, emails
 *   logo-print.png  760px wide   certificate header, signature certification
 *   logo-mark.png   square       favicon and anywhere a wordmark will not fit
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const SRC = process.argv[2] || path.resolve(import.meta.dirname, '..', 'brand', 'signflow-logo-source.png');
const OUT = path.resolve(import.meta.dirname, '..', 'public', 'brand');
fs.mkdirSync(OUT, { recursive: true });

const src = PNG.sync.read(fs.readFileSync(SRC));
console.log(`source ${src.width}x${src.height}  ${(fs.statSync(SRC).size / 1024).toFixed(0)} KB`);

/** Tight bounding box of everything that is not fully transparent. */
function contentBounds(img, alphaFloor = 8) {
  let top = img.height, left = img.width, right = -1, bottom = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > alphaFloor) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return right < left ? { x: 0, y: 0, w: img.width, h: img.height } : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

function crop(img, { x, y, w, h }) {
  const out = new PNG({ width: w, height: h });
  for (let row = 0; row < h; row++) {
    img.data.copy(out.data, row * w * 4, ((y + row) * img.width + x) * 4, ((y + row) * img.width + x + w) * 4);
  }
  return out;
}

/**
 * Box-filter downscale. Colours are averaged premultiplied by alpha — without
 * that, fully transparent pixels drag their (usually black) colour into the
 * average and the logo picks up a dark halo along every edge.
 */
function resize(img, targetW) {
  const scale = targetW / img.width;
  const targetH = Math.max(1, Math.round(img.height * scale));
  const out = new PNG({ width: targetW, height: targetH });

  for (let y = 0; y < targetH; y++) {
    const y0 = Math.floor((y * img.height) / targetH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / targetH));
    for (let x = 0; x < targetW; x++) {
      const x0 = Math.floor((x * img.width) / targetW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / targetW));

      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const o = (sy * img.width + sx) * 4;
          const alpha = img.data[o + 3] / 255;
          r += img.data[o] * alpha;
          g += img.data[o + 1] * alpha;
          b += img.data[o + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const o = (y * targetW + x) * 4;
      const meanA = a / n;
      // Un-premultiply so the stored colour is correct at the averaged alpha.
      out.data[o] = meanA > 0 ? Math.round(r / a) : 0;
      out.data[o + 1] = meanA > 0 ? Math.round(g / a) : 0;
      out.data[o + 2] = meanA > 0 ? Math.round(b / a) : 0;
      out.data[o + 3] = Math.round(meanA * 255);
    }
  }
  return out;
}

const write = (name, img) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, PNG.sync.write(img, { deflateLevel: 9 }));
  console.log(`  ${name.padEnd(16)} ${String(img.width).padStart(4)}x${String(img.height).padEnd(4)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
};

// Trim the transparent margin first so every derived size is edge-to-edge and
// the app can position it without guessing at the padding baked into the file.
const bounds = contentBounds(src);
const trimmed = crop(src, bounds);
console.log(`trimmed to ${trimmed.width}x${trimmed.height}`);

write('logo-web.png', resize(trimmed, 440));
write('logo-print.png', resize(trimmed, 760));

/**
 * Finds where the leading glyph ends by looking for the kerning gap.
 *
 * Looking for an empty column does not work on this logo: the drop shadow and
 * the bevel bridge every column of the wordmark, so nothing is ever fully
 * clear. The thinnest column in the region where the first letter must end is
 * a far better signal than a magic fraction of the width.
 */
function firstGlyphWidth(img, { from = 0.1, to = 0.26, alphaFloor = 140 } = {}) {
  const inkInColumn = (x) => {
    let n = 0;
    for (let y = 0; y < img.height; y++) {
      if (img.data[(y * img.width + x) * 4 + 3] > alphaFloor) n++;
    }
    return n;
  };

  let bestX = Math.round(img.width * to);
  let bestInk = Infinity;
  for (let x = Math.round(img.width * from); x < Math.round(img.width * to); x++) {
    const ink = inkInColumn(x);
    if (ink < bestInk) { bestInk = ink; bestX = x; }
  }
  return bestX;
}

/** Centres an image inside a transparent square, without cropping it. */
function letterboxSquare(img, pad = 0.06) {
  const side = Math.round(Math.max(img.width, img.height) * (1 + pad * 2));
  const out = new PNG({ width: side, height: side, fill: true });
  out.data.fill(0);
  const dx = Math.round((side - img.width) / 2);
  const dy = Math.round((side - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(out.data, ((y + dy) * side + dx) * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return out;
}

// Square mark: the leading glyph on its own, for the favicon and anywhere the
// full wordmark would be reduced to an illegible smear.
const glyphW = firstGlyphWidth(trimmed);
const glyph = crop(trimmed, { x: 0, y: 0, w: glyphW, h: trimmed.height });
const glyphBounds = contentBounds(glyph);
console.log(`leading glyph ${glyphBounds.w}x${glyphBounds.h}`);
write('logo-mark.png', resize(letterboxSquare(crop(glyph, glyphBounds)), 128));
