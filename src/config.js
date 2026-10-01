import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function requiredSecret(name, devFallbackFile) {
  const fromEnv = process.env[name];
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set to a random value of at least 32 characters in production.`);
  }
  // Development convenience: persist a generated secret so sessions and the
  // SMTP-password key survive a restart. Never used when NODE_ENV=production.
  const file = path.join(ROOT, '.secrets', devFallbackFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), 'utf8');
  return fs.readFileSync(file, 'utf8').trim();
}

export const config = {
  port: Number(process.env.PORT || 3000),
  // Public origin used to build signing links that go out by email.
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: requiredSecret('SESSION_SECRET', 'session.key'),
  // AES-256-GCM key protecting stored SMTP passwords at rest.
  appKey: requiredSecret('APP_KEY', 'app.key'),
  storageDir: process.env.STORAGE_DIR || path.join(ROOT, 'storage'),
  dbPath: process.env.DB_PATH || path.join(ROOT, 'storage', 'signflow.db'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024),
  // Where documents are held. Surfaced on the certificate and privacy notice,
  // so change it if you host somewhere else.
  dataRegion: process.env.DATA_REGION || 'South Africa (af-south-1, Cape Town)',
  // Short form for email footers, where the region qualifier is noise.
  dataRegionShort: process.env.DATA_REGION_SHORT || 'South Africa',
  displayTz: process.env.DISPLAY_TZ || 'Africa/Johannesburg',
  // Provenance line printed along the bottom of every page of a sealed
  // document. Turn off for source files whose own content reaches the page
  // edge, where it would overlap rather than sit in the margin.
  pageFooter: process.env.PAGE_FOOTER !== 'off',
  pageFooterText: process.env.PAGE_FOOTER_TEXT || 'Signed via {brand}   ·   Document {id}',
  brand: {
    name: process.env.BRAND_NAME || 'SignFlow',
    legalName: process.env.BRAND_LEGAL_NAME || '',
    regNo: process.env.BRAND_REG_NO || '',
    address: process.env.BRAND_ADDRESS || '',
    informationOfficer: process.env.BRAND_INFORMATION_OFFICER || '',
    popiaRegNo: process.env.BRAND_POPIA_REG_NO || '',
  },
};

fs.mkdirSync(path.join(config.storageDir, 'originals'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'sealed'), { recursive: true });
fs.mkdirSync(path.join(config.storageDir, 'uploads'), { recursive: true });
