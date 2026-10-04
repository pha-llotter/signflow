import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { config } from './config.js';
import { db, nowIso } from './db.js';

/**
 * A company's own logo: on its certificates, at the top of its emails, and in
 * its sidebar.
 *
 * PNG or JPEG only — the two formats a PDF can carry without conversion — and
 * small, because the image is embedded into every certificate the company
 * seals: a heavy logo is a heavy document, a thousand times over.
 */
export const LOGO_MAX_BYTES = 1024 * 1024;
const DIR = path.resolve(config.storageDir, 'logos');

export const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
});

const isPng = (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Checks an uploaded file is an image the certificate can actually use. The
 * type is judged by its bytes, not its name or the browser's claim, and the
 * proof is embedding it into a scratch PDF — the same step sealing performs,
 * so a logo that passes here cannot fail a seal later.
 */
export async function readLogo(file) {
  if (!file?.buffer?.length) throw new Error('Choose an image to upload.');
  const buf = file.buffer;
  const ext = isPng(buf) ? 'png' : isJpeg(buf) ? 'jpg' : null;
  if (!ext) throw new Error('The logo must be a PNG or JPG image.');

  let image;
  try {
    const scratch = await PDFDocument.create();
    image = ext === 'png' ? await scratch.embedPng(buf) : await scratch.embedJpg(buf);
  } catch {
    throw new Error('That image could not be read. Try saving it again as a PNG.');
  }
  if (image.width < 16 || image.height < 16) throw new Error('That image is too small to print legibly.');
  return { buf, ext, width: image.width, height: image.height };
}

/** Writes the new logo, then removes the one it replaces. */
export function saveCompanyLogo(companyId, { buf, ext, width, height }) {
  const previous = db.prepare('SELECT logo_path FROM companies WHERE id = ?').get(companyId)?.logo_path;
  // A new name each time, so a browser holding the old one in its cache asks again.
  const file = path.join(DIR, `${companyId}-${Date.now()}.${ext}`);
  fs.writeFileSync(file, buf);
  db.prepare('UPDATE companies SET logo_path = ?, logo_width = ?, logo_height = ?, logo_updated_at = ? WHERE id = ?')
    .run(file, width, height, nowIso(), companyId);
  if (previous && previous !== file) fs.rmSync(previous, { force: true });
}

export function removeCompanyLogo(companyId) {
  const previous = db.prepare('SELECT logo_path FROM companies WHERE id = ?').get(companyId)?.logo_path;
  db.prepare('UPDATE companies SET logo_path = NULL, logo_width = NULL, logo_height = NULL, logo_updated_at = ? WHERE id = ?')
    .run(nowIso(), companyId);
  if (previous) fs.rmSync(previous, { force: true });
}

/**
 * The logo's bytes and size, or null when the company has none — or its file
 * has gone missing, which must degrade to the plain layout, never break a seal.
 */
export function companyLogo(companyId) {
  if (!companyId) return null;
  const c = db.prepare('SELECT logo_path, logo_width, logo_height FROM companies WHERE id = ?').get(companyId);
  if (!c?.logo_path) return null;
  try {
    return {
      bytes: fs.readFileSync(c.logo_path),
      ext: path.extname(c.logo_path).slice(1),
      width: c.logo_width,
      height: c.logo_height,
    };
  } catch {
    return null;
  }
}

export async function embedCompanyLogo(pdf, companyId) {
  const logo = companyLogo(companyId);
  if (!logo) return null;
  try {
    return logo.ext === 'png' ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
  } catch {
    return null;
  }
}

/** Scales a logo into a box without distorting it. */
export function fitLogo(width, height, maxW, maxH) {
  const scale = Math.min(maxW / width, maxH / height, 1);
  return { w: Math.round(width * scale), h: Math.round(height * scale) };
}
