// Produces a sealed sample document so the certificate layout can be eyeballed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const OUT = process.argv[2];
process.env.STORAGE_DIR = path.join(OUT, 'storage');
process.env.DB_PATH = path.join(OUT, 'storage', 'sample.db');
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.APP_KEY = crypto.randomBytes(32).toString('hex');
process.env.BRAND_NAME = 'SignFlow';
process.env.BASE_URL = 'https://sign.example.co.za';
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const { db, nowIso } = await import('../src/db.js');
const { sealDocument } = await import('../src/seal.js');
const { sha256Buffer, uuid } = await import('../src/crypto.js');

// --- a plausible source document ---
const src = await PDFDocument.create();
const font = await src.embedFont(StandardFonts.Helvetica);
const bold = await src.embedFont(StandardFonts.HelveticaBold);
for (let i = 0; i < 2; i++) {
  const p = src.addPage([595.28, 841.89]);
  p.drawText(i === 0 ? 'ICT Acceptable Usage Policy' : 'Acceptance and signature', {
    x: 56, y: 770, size: 19, font: bold, color: rgb(0.1, 0.2, 0.42) });
  p.drawText('Protea Heights Academy', { x: 56, y: 745, size: 11, font, color: rgb(0.4, 0.43, 0.48) });
  if (i === 1) {
    p.drawText('Signed:', { x: 56, y: 470, size: 10, font });
    p.drawText('Date:', { x: 56, y: 400, size: 10, font });
    p.drawText('Full name:', { x: 320, y: 470, size: 10, font });
    p.drawText('Capacity:', { x: 320, y: 400, size: 10, font });
  }
}
const bytes = Buffer.from(await src.save());
const originalPath = path.join(process.env.STORAGE_DIR, 'original.pdf');
fs.writeFileSync(originalPath, bytes);

// --- seed the database as if the flow had run ---
const userId = uuid();
const docId = uuid();
const r1 = uuid();
const r2 = uuid();

db.prepare(`INSERT INTO users (id,email,password_hash,display_name,org_name,created_at) VALUES (?,?,?,?,?,?)`)
  .run(userId, 'llotter@phahs.org.za', 'x', 'Luan Lötter', 'Protea Heights Academy', nowIso());

db.prepare(`INSERT INTO documents (id,owner_id,title,filename,page_count,page_sizes,original_path,original_sha256,status,created_at,sent_at,completed_at)
            VALUES (?,?,?,?,?,?,?,?,'completed',?,?,?)`)
  .run(docId, userId, 'ICT Policy', 'ict-policy.pdf', 2,
       JSON.stringify([{ w: 595.28, h: 841.89, rotation: 0 }, { w: 595.28, h: 841.89, rotation: 0 }]),
       originalPath, sha256Buffer(bytes),
       '2026-09-27T09:02:17Z', '2026-09-27T09:02:19Z', '2026-09-27T09:03:04Z');

db.prepare(`INSERT INTO recipients (id,document_id,name,email,order_index,status,viewed_at,signed_at,consent_at,last_ip)
            VALUES (?,?,?,?,?,'signed',?,?,?,?)`)
  .run(r1, docId, 'Luan Test', 'llotter@phahs.org.za', 0,
       '2026-09-27T09:02:38Z', '2026-09-27T09:03:04Z', '2026-09-27T09:03:04Z', '102.132.184.53');
db.prepare(`INSERT INTO recipients (id,document_id,name,email,order_index,status,viewed_at,signed_at,consent_at,last_ip)
            VALUES (?,?,?,?,?,'signed',?,?,?,?)`)
  .run(r2, docId, 'Sample Second Signer', 'second@example.test', 1,
       '2026-09-27T10:11:02Z', '2026-09-27T10:12:40Z', '2026-09-27T10:12:40Z', '41.76.108.9');

/**
 * A plausible handwritten signature as a transparent PNG, drawn straight into
 * pixels. Node has no canvas, and a 1x1 placeholder tells you nothing about
 * whether the signature band in the certification block is sized right.
 */
function signaturePng(width = 520, height = 170) {
  const px = Buffer.alloc(width * height * 4); // RGBA, zeroed = transparent

  const plot = (x, y, a) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const o = (yi * width + xi) * 4;
    const alpha = Math.round(a * 255);
    if (alpha <= px[o + 3]) return;
    px[o] = 16; px[o + 1] = 35; px[o + 2] = 63; px[o + 3] = alpha;
  };

  // A stroke of a few pixels' width, drawn by sampling a parametric curve.
  const stroke = (fn, from, to, weight) => {
    const steps = 3000;
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      const { x, y } = fn(t);
      for (let dx = -weight; dx <= weight; dx += 0.5) {
        for (let dy = -weight; dy <= weight; dy += 0.5) {
          const d = Math.hypot(dx, dy);
          if (d <= weight) plot(x + dx, y + dy, Math.min(1, 1.3 - d / weight));
        }
      }
    }
  };

  // Main flourish, then a crossing underline — enough to read as a signature.
  stroke((t) => ({
    x: 40 + t * 400,
    y: 110 - Math.sin(t * Math.PI * 3.1) * 52 - t * 18 + Math.sin(t * 19) * 4,
  }), 0, 1, 2.2);
  stroke((t) => ({ x: 60 + t * 430, y: 128 + Math.sin(t * Math.PI) * -9 }), 0, 1, 1.6);
  stroke((t) => ({
    x: 130 + Math.cos(t * Math.PI * 2) * 34,
    y: 74 + Math.sin(t * Math.PI * 2) * 30,
  }), 0, 0.8, 1.8);

  // Minimal PNG writer: one filter byte per scanline, then deflate.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    px.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SIG = signaturePng().toString('base64');

const f = db.prepare(`INSERT INTO fields (id,document_id,recipient_id,type,page,x,y,w,h,required,font_size,align,color,meta,value)
                      VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)`);
f.run(uuid(), docId, r1, 'signature', 1, 0.18, 0.40, 0.32, 0.09, 11, 'left', '#111111', '{}', `data:image/png;base64,${SIG}`);
f.run(uuid(), docId, r1, 'date_signed', 1, 0.18, 0.513, 0.18, 0.026, 10, 'left', '#111111', '{}', '2026-09-27');
f.run(uuid(), docId, r1, 'name', 1, 0.62, 0.425, 0.28, 0.026, 10, 'left', '#111111', '{}', 'Luan Test');
f.run(uuid(), docId, r1, 'title', 1, 0.62, 0.513, 0.28, 0.026, 10, 'left', '#111111', '{}', 'ICT Coordinator');
f.run(uuid(), docId, null, 'stamp', 0, 0.62, 0.10, 0.24, 0.062, 11, 'center', '#111111', '{"text":"APPROVED","dated":true}', null);
f.run(uuid(), docId, null, 'qrcode', 1, 0.80, 0.86, 0.10, 0.072, 11, 'left', '#111111', '{}', null);
f.run(uuid(), docId, null, 'label', 0, 0.08, 0.92, 0.5, 0.025, 8, 'left', '#6b7280', '{"text":"Sealed electronically — verify at sign.example.co.za"}', null);

const ev = (recipientId, actor, action, detail, at, ip) =>
  db.prepare(`INSERT INTO audit_events (document_id,recipient_id,actor,action,detail,ip,user_agent,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(docId, recipientId, actor, action, detail, ip, 'Mozilla/5.0', at);

ev(null, 'llotter@phahs.org.za', 'Envelope created', 'ict-policy.pdf · 2 page(s)', '2026-09-27T09:02:17Z', '102.132.184.53');
ev(null, 'llotter@phahs.org.za', 'Document sent', null, '2026-09-27T09:02:19Z', '102.132.184.53');
ev(r1, 'llotter@phahs.org.za', 'Email sent', 'Invitation to llotter@phahs.org.za', '2026-09-27T09:02:19Z', '102.132.184.53');
ev(r1, 'Luan Test', 'Opened the document', null, '2026-09-27T09:02:38Z', '102.132.184.53');
ev(r1, 'Luan Test', 'Consent recorded', 'Agreed to sign electronically and to this audit trail being kept', '2026-09-27T09:03:04Z', '102.132.184.53');
ev(r1, 'Luan Test', 'Signature applied', null, '2026-09-27T09:03:04Z', '102.132.184.53');
ev(r2, 'Sample Second Signer', 'Opened the document', null, '2026-09-27T10:11:02Z', '41.76.108.9');
ev(r2, 'Sample Second Signer', 'Consent recorded', 'Agreed to sign electronically and to this audit trail being kept', '2026-09-27T10:12:40Z', '41.76.108.9');
ev(r2, 'Sample Second Signer', 'Signature applied', null, '2026-09-27T10:12:40Z', '41.76.108.9');
ev(null, 'System', 'Document completed', null, '2026-09-27T10:12:40Z', null);

const result = await sealDocument(docId);
fs.copyFileSync(result.sealedPath, path.join(OUT, 'sealed-sample.pdf'));
console.log('sealed →', path.join(OUT, 'sealed-sample.pdf'));
console.log('signed sha256:', result.signedSha);
console.log('sealed sha256:', result.sealedSha);
