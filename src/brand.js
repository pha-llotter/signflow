import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

/**
 * The brand assets, in the two sizes the app actually uses.
 *
 * `scripts/build-brand.js` derives these from the full-resolution source. The
 * print copy is the one embedded into PDFs, so it is deliberately not the
 * 790 KB original — that would be added to the weight of every sealed document.
 */
const FILES = {
  web: process.env.BRAND_LOGO_WEB || path.join(ROOT, 'public', 'brand', 'logo-web.png'),
  print: process.env.BRAND_LOGO_PRINT || path.join(ROOT, 'public', 'brand', 'logo-print.png'),
  mark: process.env.BRAND_LOGO_MARK || path.join(ROOT, 'public', 'brand', 'logo-mark.png'),
};

const cache = new Map();

/** Reads an asset once. Returns null when it is absent rather than throwing —
 *  a missing logo should degrade to the brand name, not break sealing. */
export function logoBytes(which = 'print') {
  if (cache.has(which)) return cache.get(which);
  let bytes = null;
  try {
    bytes = fs.readFileSync(FILES[which]);
  } catch {
    console.warn(`[brand] ${FILES[which]} not found — run: node scripts/build-brand.js`);
  }
  cache.set(which, bytes);
  return bytes;
}

/**
 * Embeds the wordmark into a PDF, memoised per document so a page-per-signature
 * envelope does not carry ten copies of the same image.
 */
const embedded = new WeakMap();
export async function embedLogo(pdf, which = 'print') {
  let perDoc = embedded.get(pdf);
  if (!perDoc) { perDoc = new Map(); embedded.set(pdf, perDoc); }
  if (perDoc.has(which)) return perDoc.get(which);

  const bytes = logoBytes(which);
  let image = null;
  if (bytes) {
    try {
      image = await pdf.embedPng(bytes);
    } catch (err) {
      console.warn(`[brand] could not embed logo: ${err.message}`);
    }
  }
  perDoc.set(which, image);
  return image;
}

/** Inline attachment so the logo renders in mail clients that block remote images. */
export function mailLogoAttachment() {
  const bytes = logoBytes('web');
  if (!bytes) return null;
  return { filename: 'logo.png', content: bytes, cid: 'signflow-logo', contentDisposition: 'inline' };
}

export const brandName = () => config.brand.name;
