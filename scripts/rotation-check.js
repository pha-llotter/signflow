/**
 * Verifies that stamped content lands where the reader sees it on pages with a
 * /Rotate entry.
 *
 *   node scripts/rotation-check.js [outDir]
 *
 * PDF.js honours /Rotate when it renders; pdf-lib does not when it draws. Every
 * stamp therefore goes through placeRect(), which carries the anchor round and
 * spins the content to match. Scanned documents routinely arrive rotated, and a
 * mistake here is invisible until a signature turns up sideways in the margin
 * of somebody's signed contract — so it is asserted rather than assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

const OUT = process.argv[2] || path.resolve(import.meta.dirname, '..', 'rotation-check');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signflow-rot-'));
fs.mkdirSync(OUT, { recursive: true });

process.env.STORAGE_DIR = TMP;
process.env.DB_PATH = path.join(TMP, 'rot.db');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.APP_KEY = crypto.randomBytes(32).toString('hex');
process.env.BRAND_NAME = 'SignFlow';
process.env.BASE_URL = 'https://sign.example.co.za';

const { db, nowIso } = await import('../src/db.js');
const { sealDocument } = await import('../src/seal.js');
const { sha256Buffer, uuid } = await import('../src/crypto.js');

const ROTATIONS = [0, 90, 180, 270];
let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? `\n          ${extra}` : ''}`); }
};

// --- a source document with one page at each rotation ------------------------
const src = await PDFDocument.create();
const bold = await src.embedFont(StandardFonts.HelveticaBold);
for (const r of ROTATIONS) {
  const p = src.addPage([595.28, 841.89]);
  p.setRotation(degrees(r));
  p.drawText(`Rotation ${r}`, { x: 56, y: 760, size: 18, font: bold, color: rgb(0.1, 0.2, 0.42) });
}
const bytes = Buffer.from(await src.save());
const originalPath = path.join(TMP, 'rotated.pdf');
fs.writeFileSync(originalPath, bytes);

// --- seed it as a completed envelope -----------------------------------------
const userId = uuid();
const docId = uuid();
const rid = uuid();

db.prepare(`INSERT INTO users (id,email,password_hash,display_name,created_at) VALUES (?,?,?,?,?)`)
  .run(userId, 'rot@example.test', 'x', 'Rotation Test', nowIso());
db.prepare(`INSERT INTO documents (id,owner_id,title,filename,page_count,page_sizes,original_path,original_sha256,status,created_at,completed_at)
            VALUES (?,?,?,?,?,?,?,?,'completed',?,?)`)
  .run(docId, userId, 'Rotation Test', 'rotated.pdf', ROTATIONS.length,
       JSON.stringify(ROTATIONS.map(() => ({ w: 595.28, h: 841.89 }))),
       originalPath, sha256Buffer(bytes), nowIso(), nowIso());
db.prepare(`INSERT INTO recipients (id,document_id,name,email,order_index,status,signed_at,last_ip)
            VALUES (?,?,?,?,0,'signed',?,?)`)
  .run(rid, docId, 'Rotation Signer', 'rot@example.test', nowIso(), '127.0.0.1');

// A label near the visual top-left of each page: an unambiguous probe, since a
// mishandled rotation sends it to a different corner entirely.
const insert = db.prepare(`INSERT INTO fields (id,document_id,recipient_id,type,page,x,y,w,h,required,font_size,align,color,meta,value)
                           VALUES (?,?,NULL,'label',?,?,?,?,?,1,?,'left','#111111',?,NULL)`);
ROTATIONS.forEach((r, i) => {
  insert.run(uuid(), docId, i, 0.08, 0.06, 0.5, 0.03, 11, JSON.stringify({ text: `TOPLEFT-${r}` }));
});

const { sealedPath } = await sealDocument(docId);
fs.copyFileSync(sealedPath, path.join(OUT, 'rotated-sealed.pdf'));

// --- read it back the way a reader sees it -----------------------------------
const { getDocument, Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const pdf = await getDocument({ data: new Uint8Array(fs.readFileSync(sealedPath)), useSystemFonts: true }).promise;

console.log('\nRotation check\n');

for (let i = 0; i < ROTATIONS.length; i++) {
  const r = ROTATIONS[i];
  const page = await pdf.getPage(i + 1);
  // The viewport applies /Rotate, so its coordinates are what the reader sees:
  // x rightwards, y downwards from the visual top-left corner.
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const found = {};
  for (const item of content.items) {
    const t = Util.transform(viewport.transform, item.transform);
    const str = item.str.trim();
    if (!str) continue;
    const at = { x: Math.round(t[4]), y: Math.round(t[5]) };
    if (str.includes('TOPLEFT')) found.label = at;
    if (str.includes('Signed via')) found.footer = at;
  }

  const okLabel =
    found.label &&
    found.label.x < viewport.width * 0.45 &&
    found.label.y < viewport.height * 0.25;
  check(`rotation ${String(r).padStart(3)}: label lands top-left as displayed`, !!okLabel,
    found.label ? `at ${found.label.x},${found.label.y} of ${Math.round(viewport.width)}x${Math.round(viewport.height)}` : 'not found');

  const okFooter = found.footer && found.footer.y > viewport.height * 0.9;
  check(`rotation ${String(r).padStart(3)}: footer sits on the visual bottom edge`, !!okFooter,
    found.footer ? `at ${found.footer.x},${found.footer.y} of ${Math.round(viewport.width)}x${Math.round(viewport.height)}` : 'not found');
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(`sealed PDF → ${path.join(OUT, 'rotated-sealed.pdf')}\n`);

db.close();
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); } catch {}
process.exit(failed === 0 ? 0 : 1);
