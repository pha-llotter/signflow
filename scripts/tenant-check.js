/**
 * Multi-company checks. Drives the real HTTP surface with two companies and
 * asserts that neither can see or touch the other's people, invitations,
 * templates or documents; that company administrators cannot reach the
 * platform pages; that the platform owner sees counts and people but never a
 * document; and that suspending a company signs its people out without
 * stranding the signers it has already sent links to.
 *
 *   npm run tenant-check
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

import Database from 'better-sqlite3';
import { PDFDocument, PDFRawStream, PDFName } from 'pdf-lib';
import { PNG } from 'pngjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ten-'));
const PORT = 3993, BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(TMP, 'a.db');
const server = spawn(process.execPath, ['src/server.js'], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), BASE_URL: BASE, STORAGE_DIR: TMP, DB_PATH: DB,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'), APP_KEY: crypto.randomBytes(32).toString('hex'),
    // Reminders are swept every 15 minutes in real life; here, fast enough to watch.
    REMINDER_SWEEP_MS: '400' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; server.stdout.on('data', (d) => (log += d)); server.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 100; i++) { try { await fetch(`${BASE}/login`); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && extra !== '' ? '\n          ' + extra : ''}`); };
function session() {
  const jar = new Map();
  return async (method, url, { body, headers = {} } = {}) => {
    const res = await fetch(BASE + url, { method, redirect: 'manual', body,
      headers: { ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...headers } });
    for (const raw of res.headers.getSetCookie?.() || []) { const [p] = raw.split(';'); const i = p.indexOf('='); jar.set(p.slice(0, i), p.slice(i + 1)); }
    return res;
  };
}
const form = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) for (const x of [].concat(v)) p.append(k, String(x)); return { body: p, headers: { 'content-type': 'application/x-www-form-urlencoded' } }; };
const loc = (r) => r.headers.get('location') || '';
const text = async (s, url) => (await s('GET', url)).text();
async function pdf() { const d = await PDFDocument.create(); d.addPage([595, 842]); return Buffer.from(await d.save()); }
const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function sendDoc(s, title, name, email) {
  const fd = new FormData();
  fd.append('pdf', new Blob([await pdf()], { type: 'application/pdf' }), 'x.pdf');
  fd.append('title', title); fd.append('recipient_name', name); fd.append('recipient_email', email);
  const id = (loc(await s('POST', '/documents/new', { body: fd })).match(/documents\/([0-9a-f-]{36})/) || [])[1];
  const rid = (await text(s, `/documents/${id}/prepare`)).match(/data-id="([0-9a-f-]{36})"/)?.[1];
  const fid = crypto.randomUUID();
  await s('PUT', `/api/documents/${id}/fields`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: [{ id: fid, type: 'signature', recipient_id: rid, page: 0, x: .2, y: .6, w: .3, h: .08 }] }) });
  await s('POST', `/documents/${id}/send`);
  const tok = (await text(s, `/documents/${id}`)).match(/\/sign\/([A-Za-z0-9_-]{40,})/)?.[1];
  return { id, tok, fid };
}
const signIn = async (s, email, password) => s('POST', '/login', form({ email, password }));

try {
  const db = new Database(DB);
  const owner = session();
  await owner('POST', '/register', form({ email: 'luan@protea.test', display_name: 'Luan Lötter', org_name: 'Protea Heights Academy', password: 'owner-long-password' }));
  const protea = db.prepare(`SELECT * FROM companies`).get();
  const luan = db.prepare(`SELECT * FROM users WHERE email='luan@protea.test'`).get();

  console.log('\nfirst run');
  check('register founds the first company and owns the platform', protea?.name === 'Protea Heights Academy' && luan.company_id === protea.id && luan.platform_admin === 1 && luan.role === 'admin');
  check('platform page opens for the owner', (await owner('GET', '/platform')).status === 200);
  check('sidebar shows the Platform link to the owner', (await text(owner, '/dashboard')).includes('href="/platform"'));

  console.log('\ncreate a company');
  let res = await owner('POST', '/platform/companies', form({ name: 'Riverside Primary', admin_email: 'Head@Riverside.test' }));
  const riverside = db.prepare(`SELECT * FROM companies WHERE name='Riverside Primary'`).get();
  check('company created and lands on its page', !!riverside && loc(res) === `/platform/companies/${riverside.id}`);
  const inv = db.prepare(`SELECT * FROM invitations WHERE company_id = ?`).get(riverside.id);
  check('first administrator invited into it (email lower-cased)', inv?.role === 'admin' && inv.email === 'head@riverside.test');
  res = await owner('POST', '/platform/companies', form({ name: 'riverside primary', admin_email: 'x@y.test' }));
  check('duplicate company name refused', !db.prepare(`SELECT 1 FROM companies WHERE name='riverside primary'`).get());
  await owner('POST', '/platform/companies', form({ name: 'Other Co', admin_email: 'luan@protea.test' }));
  check('an email that already has an account is refused', !db.prepare(`SELECT 1 FROM companies WHERE name='Other Co'`).get());

  const invitePage = await (await fetch(`${BASE}/invite/${inv.token}`)).text();
  check('invitation page names the company', invitePage.includes('Riverside Primary'));
  const head = session();
  res = await head('POST', `/invite/${inv.token}`, form({ display_name: 'Riverside Head', password: 'head-long-password', password_confirm: 'head-long-password' }));
  const headUser = db.prepare(`SELECT * FROM users WHERE email='head@riverside.test'`).get();
  check('accepting joins Riverside as its administrator', loc(res) === '/dashboard' && headUser.company_id === riverside.id && headUser.role === 'admin' && !headUser.platform_admin);

  console.log('\nisolation');
  check('a company admin cannot open the platform pages', (await head('GET', '/platform')).status === 404 && (await head('GET', `/platform/companies/${protea.id}`)).status === 404);
  check('...or create a company', (await head('POST', '/platform/companies', form({ name: 'Sneaky', admin_email: 's@s.test' }))).status === 404 && !db.prepare(`SELECT 1 FROM companies WHERE name='Sneaky'`).get());
  const rTeam = await text(head, '/team');
  const rLog = await text(head, '/activity');
  const people = rTeam;
  check('Team shows only their own people', people.includes('head@riverside.test') && !people.includes('luan@protea.test'));
  check('their activity log records the platform owner inviting them', rLog.includes('Invitation sent'));
  check('...and only their own activity', !rLog.includes('Platform created') && !rLog.includes('Company created'));
  await head('POST', `/team/user/${luan.id}/role`, form({ role: 'member' }));
  await head('POST', `/team/user/${luan.id}/status`, form({ status: 'suspended' }));
  await head('POST', `/team/user/${luan.id}/reset`);
  const luanAfter = db.prepare(`SELECT role, status FROM users WHERE id=?`).get(luan.id);
  check('cannot demote, deactivate or reset another company\'s user by id', luanAfter.role === 'admin' && luanAfter.status === 'active' && !db.prepare('SELECT 1 FROM password_resets WHERE user_id=?').get(luan.id));
  await owner('POST', '/team/invite', form({ email: 'teacher@protea.test', role: 'member' }));
  const pInv = db.prepare(`SELECT * FROM invitations WHERE email='teacher@protea.test'`).get();
  await head('POST', `/team/invite/${pInv.id}/revoke`);
  check('cannot revoke another company\'s invitation', !db.prepare('SELECT revoked_at FROM invitations WHERE id=?').get(pInv.id).revoked_at);
  check('Protea\'s invitation is tagged Protea', pInv.company_id === protea.id);
  await head('POST', `/team/user/${headUser.id}/role`, form({ role: 'member' }));
  check('last-admin guard counts only their own company', db.prepare('SELECT role FROM users WHERE id=?').get(headUser.id).role === 'admin');

  // Team template isolation.
  const fd = new FormData();
  fd.append('pdf', new Blob([await pdf()], { type: 'application/pdf' }), 't.pdf');
  fd.append('title', 'Protea Indemnity'); fd.append('visibility', 'team'); fd.append('role_id', ''); fd.append('role_name', 'Parent');
  const tplId = (loc(await owner('POST', '/templates/new', { body: fd })).match(/documents\/([0-9a-f-]{36})/) || [])[1];
  check('templates are tagged with the company', db.prepare('SELECT company_id FROM documents WHERE id=?').get(tplId).company_id === protea.id);
  check('another company does not see a team template', !(await text(head, '/templates')).includes('Protea Indemnity'));
  check('...cannot open it to use, or fetch its PDF', (await head('GET', `/templates/${tplId}/use`)).status === 404 && (await head('GET', `/documents/${tplId}/original.pdf`)).status === 404);

  // Waiting-for-me across companies.
  const cross = await sendDoc(owner, 'Protea to Riverside head', 'Riverside Head', 'head@riverside.test');
  check('documents carry the sender\'s company', db.prepare('SELECT company_id FROM documents WHERE id=?').get(cross.id).company_id === protea.id);
  check('another company\'s document is not on their dashboard', !(await text(head, '/dashboard')).includes('Protea to Riverside head'));
  check('...but its signing link still works for them', (await fetch(`${BASE}/sign/${cross.tok}`)).status === 200);

  console.log('\nsettings and mail');
  const rSettings = await text(head, '/settings');
  check('settings show their own company', rSettings.includes('value="Riverside Primary"') && !rSettings.includes('Protea Heights Academy'));
  await head('POST', '/settings', form({ name: 'Riverside Primary School', mail_source: 'own', smtp_host: 'smtp.riverside.test', smtp_port: '587', from_email: 'noreply@riverside.test' }));
  const r2 = db.prepare('SELECT * FROM companies WHERE id=?').get(riverside.id);
  check('rename and own mail server saved on their company only', r2.name === 'Riverside Primary School' && r2.smtp_host === 'smtp.riverside.test' && !db.prepare('SELECT smtp_host FROM companies WHERE id=?').get(protea.id).smtp_host);
  check('their sidebar shows the new name', (await text(head, '/dashboard')).includes('Riverside Primary School'));
  // Settings sections save separately: the name alone must not touch the mail
  // server, and the mail alone must not touch the name.
  await head('POST', '/settings', form({ name: 'Riverside Primary School' }));
  check('saving only the name keeps their own mail server', db.prepare('SELECT smtp_host FROM companies WHERE id = ?').get(riverside.id).smtp_host === 'smtp.riverside.test');
  await head('POST', '/settings', form({ mail_source: 'own', smtp_host: 'smtp.riverside.test', smtp_port: '587', from_email: 'noreply@riverside.test' }));
  check('saving only the mail keeps the name', db.prepare('SELECT name FROM companies WHERE id = ?').get(riverside.id).name === 'Riverside Primary School');
  await owner('POST', '/platform/mail', form({ smtp_host: 'smtp.platform.test', smtp_port: '587', from_email: 'noreply@platform.test' }));
  const rows = db.prepare('SELECT smtp_host FROM app_settings').get();
  check('platform mail saved as the default', rows.smtp_host === 'smtp.platform.test');
  check('Protea (no override) shows platform mail in Settings', (await text(owner, '/settings')).includes('Using SignFlow mail'));
  check('Riverside shows its own server in Settings', (await text(head, '/settings')).includes('Using your server · smtp.riverside.test'));
  await head('POST', '/settings', form({ name: 'Riverside Primary School', mail_source: 'platform', smtp_host: 'ignored.test' }));
  check('switching back to platform mail clears the override', !db.prepare('SELECT smtp_host FROM companies WHERE id=?').get(riverside.id).smtp_host);

  console.log('\nplatform overview never shows documents');
  const rDoc = await sendDoc(head, 'Riverside Secret Contract', 'Parent', 'parent@riverside.test');
  const cPage = await text(owner, `/platform/companies/${riverside.id}`);
  check('company page shows people and counts', cPage.includes('head@riverside.test') && cPage.includes('Documents'));
  check('...but no document titles or recipients', !cPage.includes('Riverside Secret Contract') && !cPage.includes('parent@riverside.test'));
  check('the owner cannot open another company\'s document', (await owner('GET', `/documents/${rDoc.id}`)).status === 404 && (await owner('GET', `/documents/${rDoc.id}/original.pdf`)).status === 404);
  const pList = await text(owner, '/platform');
  check('platform list does not show document titles', pList.includes('Riverside Primary School') && !pList.includes('Riverside Secret Contract'));
  const verify = await (await fetch(`${BASE}/verify/${cross.id}`)).text();
  check('verification names the sending company', verify.includes('Protea Heights Academy'));

  console.log('\nsuspension');
  await owner('POST', `/platform/companies/${riverside.id}/status`, form({ status: 'suspended' }));
  check('suspended', db.prepare('SELECT status FROM companies WHERE id=?').get(riverside.id).status === 'suspended');
  res = await head('GET', '/dashboard');
  check('their live session is cut off with a suspension notice', loc(res) === '/login?suspended=1', loc(res));
  res = await signIn(session(), 'head@riverside.test', 'head-long-password');
  check('they cannot sign in', res.status === 401 && (await res.text()).includes('suspended'));
  check('a signing link they already sent keeps working', (await fetch(`${BASE}/sign/${rDoc.tok}`)).status === 200);
  await owner('POST', `/platform/companies/${riverside.id}/invite`, form({ email: 'deputy@riverside.test' }));
  const dInv = db.prepare(`SELECT token FROM invitations WHERE email='deputy@riverside.test'`).get();
  check('an invitation into a suspended company cannot be accepted', (await fetch(`${BASE}/invite/${dInv.token}`)).status === 410);
  await owner('POST', `/platform/companies/${riverside.id}/status`, form({ status: 'active' }));
  res = await signIn(session(), 'head@riverside.test', 'head-long-password');
  check('reactivated: they can sign in again', loc(res) === '/dashboard');
  await owner('POST', `/platform/companies/${protea.id}/status`, form({ status: 'suspended' }));
  check('suspending your own company does not lock the platform owner out', (await owner('GET', '/platform')).status === 200);
  await owner('POST', `/platform/companies/${protea.id}/status`, form({ status: 'active' }));

  console.log('\nlogs');
  const pEvents = db.prepare('SELECT action FROM admin_events WHERE company_id IS NULL').all().map((e) => e.action);
  check('platform log has platform events', ['Platform created', 'Company created', 'Administrator invited', 'Company suspended', 'Company reactivated', 'Platform mail changed'].every((a) => pEvents.includes(a)), pEvents.join(', '));
  const rEvents = db.prepare('SELECT action FROM admin_events WHERE company_id = ?').all(riverside.id).map((e) => e.action);
  check('Riverside\'s log records its own history', ['Invitation sent', 'Invitation accepted', 'Organisation settings changed', 'Organisation suspended'].every((a) => rEvents.includes(a)), rEvents.join(', '));
  console.log('\nplatform support sessions');
  const rPage = `/platform/companies/${riverside.id}`;
  check('company page offers support sign-in for its people', (await text(owner, rPage)).includes(`value="${headUser.id}"`));
  await owner('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: '' }));
  check('refused without a reason', (await owner('GET', '/platform')).status === 200);
  await owner('POST', `/platform/companies/${protea.id}/support`, form({ user_id: luan.id, reason: 'x' }));
  check('a platform owner cannot be impersonated', (await owner('GET', '/platform')).status === 200);
  await owner('POST', `/platform/companies/${protea.id}/support`, form({ user_id: headUser.id, reason: 'wrong company' }));
  check('cannot reach someone through another company\'s page', (await owner('GET', '/platform')).status === 200);

  const seenBefore = db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(headUser.id).last_seen_at;
  res = await owner('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: 'Ticket 7 — cannot find a template' }));
  check('starting lands on their dashboard', loc(res) === '/dashboard');
  const asHead = await text(owner, '/dashboard');
  check('the support banner and Exit button are shown', asHead.includes('Platform support') && asHead.includes('action="/support/exit"') && asHead.includes('Riverside Head'));
  check('they see the company as that person does', asHead.includes('Riverside Primary School') && !asHead.includes('href="/platform"'));
  check('platform pages are closed while impersonating', (await owner('GET', '/platform')).status === 404);
  check('their last-seen time is not touched by the visit', db.prepare('SELECT last_seen_at FROM users WHERE id = ?').get(headUser.id).last_seen_at === seenBefore);

  const helped = await sendDoc(owner, 'Sent during support', 'Parent Two', 'p2@riverside.test');
  const hDoc = db.prepare('SELECT owner_id, company_id FROM documents WHERE id = ?').get(helped.id);
  check('a document sent during support belongs to them', hDoc.owner_id === headUser.id && hDoc.company_id === riverside.id);
  const actors = db.prepare('SELECT actor FROM audit_events WHERE document_id = ?').all(helped.id).map((e) => e.actor);
  check('its audit trail names the platform owner acting for them', actors.some((a) => a === 'head@riverside.test (via platform support: luan@protea.test)'), actors.join(' | '));
  await owner('POST', '/team/invite', form({ email: 'helped@riverside.test', role: 'member' }));
  const tagged = db.prepare(`SELECT actor_email FROM admin_events WHERE company_id = ? AND subject = 'helped@riverside.test'`).get(riverside.id);
  check('admin actions during support are attributed to both people', tagged?.actor_email === 'luan@protea.test (platform support, as head@riverside.test)', tagged?.actor_email);
  const started = db.prepare(`SELECT * FROM admin_events WHERE company_id = ? AND action = 'Support session started'`).get(riverside.id);
  check('the company\'s own log records the session and the reason', started?.subject === 'head@riverside.test' && started.detail.includes('Ticket 7'));

  res = await owner('POST', '/logout');
  check('signing out ends support and returns to the company page', loc(res) === rPage);
  check('...back in the platform owner\'s own account', (await owner('GET', '/platform')).status === 200 && !(await text(owner, '/dashboard')).includes('Platform support'));
  check('the end is logged for the company too', !!db.prepare(`SELECT 1 FROM admin_events WHERE company_id = ? AND action = 'Support session ended'`).get(riverside.id));

  await owner('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: 'Expiry test' }));
  const row = db.prepare(`SELECT sid, sess FROM sessions WHERE sess LIKE '%impersonator%'`).get();
  const sess = JSON.parse(row.sess); sess.impersonator.expiresAt = Date.now() - 1000;
  db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(sess), row.sid);
  const after = await text(owner, '/dashboard');
  check('an expired session ends itself and returns them home', !after.includes('Platform support') && after.includes('support session ended'));
  check('...and logs that it timed out', !!db.prepare(`SELECT 1 FROM admin_events WHERE company_id = ? AND detail LIKE 'Ended automatically%'`).get(riverside.id));

  await owner('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: 'Suspension test' }));
  db.prepare(`UPDATE companies SET status = 'suspended' WHERE id = ?`).run(riverside.id);
  res = await owner('GET', '/dashboard');
  check('suspending the company mid-session returns the owner to their own account', res.status === 200 && !(await res.text()).includes('Platform support') && (await owner('GET', '/platform')).status === 200);
  db.prepare(`UPDATE companies SET status = 'active' WHERE id = ?`).run(riverside.id);
  await owner('POST', `/platform/companies/${riverside.id}/status`, form({ status: 'suspended' }));
  await owner('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: 'into a suspended company' }));
  check('cannot start a session in a suspended company', (await owner('GET', '/platform')).status === 200);
  await owner('POST', `/platform/companies/${riverside.id}/status`, form({ status: 'active' }));

  console.log('\ncompany logos');
  const wide = new PNG({ width: 400, height: 100 });
  wide.data.fill(200);
  const logoPng = PNG.sync.write(wide);
  const tiny = PNG.sync.write(new PNG({ width: 8, height: 8 }));
  const upload = (s, url, buf, name = 'logo.png', type = 'image/png') => {
    const fd = new FormData();
    fd.append('logo', new Blob([buf], { type }), name);
    return s('POST', url, { body: fd });
  };
  const rLogo = () => db.prepare('SELECT logo_path, logo_width, logo_height FROM companies WHERE id = ?').get(riverside.id);
  const head3 = session();
  await signIn(head3, 'head@riverside.test', 'head-long-password');

  await upload(head3, '/settings/logo', Buffer.from('not really an image'), 'fake.png');
  check('a file that is not a PNG or JPG is refused, whatever its name', !rLogo().logo_path);
  await upload(head3, '/settings/logo', tiny);
  check('an image too small to print is refused', !rLogo().logo_path);
  res = await upload(head3, '/settings/logo', logoPng);
  const saved = rLogo();
  check('an administrator uploads their company\'s logo', loc(res) === '/settings' && saved.logo_width === 400 && saved.logo_height === 100 && fs.existsSync(saved.logo_path));
  res = await head3('GET', `/company-logo/${riverside.id}`);
  check('their people can load it', res.status === 200 && res.headers.get('content-type').includes('image/png'));
  check('it is not public', (await fetch(`${BASE}/company-logo/${riverside.id}`)).status === 404);
  check('it shows in their sidebar and settings', (await text(head3, '/dashboard')).includes(`/company-logo/${riverside.id}`) && (await text(head3, '/settings')).includes('Replace logo'));

  const branded = await sendDoc(head3, 'Branded certificate', 'Parent Three', 'p3@riverside.test');
  await fetch(`${BASE}/sign/${branded.tok}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consent: true, values: { [branded.fid]: PNG_DATA } }) });
  const sealed = await PDFDocument.load(fs.readFileSync(db.prepare('SELECT sealed_path FROM documents WHERE id = ?').get(branded.id).sealed_path));
  const images = sealed.context.enumerateIndirectObjects()
    .map(([, o]) => o)
    .filter((o) => o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'));
  check('the sealed certificate carries the company logo', images.some((o) => o.dict.get(PDFName.of('Width'))?.asNumber?.() === 400 && o.dict.get(PDFName.of('Height'))?.asNumber?.() === 100));

  res = await upload(owner, `/platform/companies/${protea.id}/logo`, logoPng);
  check('the platform owner can upload a logo for a company', loc(res) === `/platform/companies/${protea.id}` && !!db.prepare('SELECT logo_path FROM companies WHERE id = ?').get(protea.id).logo_path);
  check('...recorded in that company\'s own log', !!db.prepare(`SELECT 1 FROM admin_events WHERE company_id = ? AND action = 'Logo changed' AND detail LIKE '%platform owner%'`).get(protea.id));
  check('a company admin cannot upload for another company', (await upload(head3, `/platform/companies/${protea.id}/logo`, tiny)).status === 404);

  const oldPath = rLogo().logo_path;
  await head3('POST', '/settings/logo/remove');
  check('removing it clears the record and deletes the file', !rLogo().logo_path && !fs.existsSync(oldPath));

  console.log('\ntrash');
  const docRow = (id) => db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  const t1 = await sendDoc(head3, 'Trash me', 'Parent Four', 'p4@riverside.test');
  const t1files = [docRow(t1.id).original_path];
  res = await head3('POST', `/documents/${t1.id}/delete`);
  check('deleting moves a document to the trash, keeping it and its files', loc(res) === '/documents' && !!docRow(t1.id)?.deleted_at && t1files.every((p) => fs.existsSync(p)));
  // The first page after deleting carries the "moved to the trash" notice,
  // which names the document; the list itself is what must not.
  check('...it leaves My Documents and the dashboard', !(await text(head3, '/documents')).includes('>Trash me</a>') && !(await text(head3, '/dashboard')).includes('Trash me</strong>'));
  check('...and shows in Trash with Restore and Delete permanently', ((await text(head3, '/documents/trash')).match(/Trash me|\/restore|\/purge/g) || []).length >= 3);
  res = await fetch(`${BASE}/sign/${t1.tok}`);
  check('its signing link is closed while it is in the trash', res.status === 410 && (await res.text()).includes('no longer available'));
  check('it cannot be sent, reminded or edited from the trash',
    (await head3('POST', `/documents/${t1.id}/remind`)).status === 302 &&
    loc(await head3('GET', `/documents/${t1.id}/prepare`)) === `/documents/${t1.id}` &&
    (await head3('PUT', `/api/documents/${t1.id}/fields`, { headers: { 'content-type': 'application/json' }, body: '{"fields":[]}' })).status === 409);

  check('another company cannot trash, restore or purge it',
    (await owner('POST', `/documents/${t1.id}/restore`)).status === 404 &&
    (await owner('POST', `/documents/${t1.id}/purge`)).status === 404 &&
    !!docRow(t1.id)?.deleted_at);

  await head3('POST', `/documents/${t1.id}/restore`);
  check('restore brings it back exactly as it was', !docRow(t1.id).deleted_at && docRow(t1.id).status === 'sent' && (await text(head3, '/documents')).includes('Trash me'));
  check('...with its signing link working again', (await fetch(`${BASE}/sign/${t1.tok}`)).status === 200);
  const trail = db.prepare('SELECT action FROM audit_events WHERE document_id = ?').all(t1.id).map((e) => e.action);
  check('the audit trail records the trip to the trash and back', trail.includes('Moved to trash') && trail.includes('Restored from trash'));

  await head3('POST', `/documents/${t1.id}/purge`);
  check('permanent deletion is refused for a document not in the trash', !!docRow(t1.id));
  await head3('POST', `/documents/${t1.id}/delete`);
  res = await head3('POST', `/documents/${t1.id}/purge`);
  check('from the trash it deletes for good: record and files', loc(res) === '/documents/trash' && !docRow(t1.id) && t1files.every((p) => !fs.existsSync(p)));

  const t2 = await sendDoc(head3, 'Trash two', 'P5', 'p5@riverside.test');
  const t3 = await sendDoc(head3, 'Trash three', 'P6', 'p6@riverside.test');
  const keep = await sendDoc(owner, 'Protea keeps this', 'P7', 'p7@protea.test');
  await head3('POST', `/documents/${t2.id}/delete`);
  await head3('POST', `/documents/${t3.id}/delete`);
  await owner('POST', `/documents/${keep.id}/delete`);
  await head3('POST', '/documents/trash/empty');
  check('Empty trash removes everything in your trash', !docRow(t2.id) && !docRow(t3.id));
  check('...and nothing in anyone else\'s', !!docRow(keep.id)?.deleted_at);

  console.log('\nverification: public and in-app');
  const sealedBytes = fs.readFileSync(db.prepare('SELECT sealed_path FROM documents WHERE id = ?').get(branded.id).sealed_path);
  const pdfUpload = (url, s) => {
    const fd = new FormData();
    fd.append('pdf', new Blob([sealedBytes], { type: 'application/pdf' }), 'sealed.pdf');
    return s ? s('POST', url, { body: fd }) : fetch(BASE + url, { method: 'POST', body: fd });
  };
  let page = await (await fetch(`${BASE}/`)).text();
  check('the public page needs no account and has no app sidebar', page.includes('Verify a document') && !page.includes('class="sidebar"'));
  page = await (await fetch(`${BASE}/verify/${branded.id}`)).text();
  check('the link printed on certificates still works for anyone', page.includes('Branded certificate'));
  page = await (await pdfUpload('/check')).text();
  check('a public upload check confirms the sealed file', /sealed document exactly as it was issued/.test(page));

  res = await fetch(`${BASE}/verification`, { redirect: 'manual' });
  check('the in-app page requires signing in', res.status === 302 && loc(res).startsWith('/login'));
  page = await text(head3, '/verification');
  check('signed in, it sits inside the app with the sidebar', page.includes('class="sidebar"') && page.includes('action="/verification"') && page.includes('action="/verification/upload"'));
  check('...and the sidebar\'s Verify link points to it', page.includes('href="/verification" class="active"'));
  page = await (await head3('POST', '/verification', form({ query: branded.id }))).text();
  check('in-app lookup by ID gives the same result', page.includes('Branded certificate') && page.includes('class="sidebar"'));
  page = await (await pdfUpload('/verification/upload', head3)).text();
  check('in-app upload check gives the same result', /sealed document exactly as it was issued/.test(page) && page.includes('class="sidebar"'));
  page = await text(head3, `/verification/${branded.id}`);
  check('in-app link by ID works too', page.includes('Branded certificate') && page.includes('class="sidebar"'));

  console.log('\nautomatic reminders');
  const sweep = () => new Promise((r) => setTimeout(r, 1300));
  const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const autoReminders = (id) => db.prepare(`SELECT * FROM audit_events WHERE document_id = ? AND action IN ('Automatic reminder sent', 'Automatic reminder not delivered') ORDER BY id`).all(id);
  const rem = await sendDoc(head3, 'Remind me', 'Slow Signer', 'slow@riverside.test');
  check('a document is sent with reminders every 3 days by default', docRow(rem.id).reminder_days === 3);
  await sweep();
  check('nothing is sent before the first interval has passed', autoReminders(rem.id).length === 0);
  db.prepare('UPDATE documents SET sent_at = ? WHERE id = ?').run(daysAgo(4), rem.id);
  await sweep();
  let rounds = autoReminders(rem.id);
  check('once due, the unsigned recipient is reminded automatically', rounds.length === 1 && rounds[0].actor === 'SignFlow (automatic)' && !!docRow(rem.id).last_reminded_at, JSON.stringify(rounds.map((r) => [r.actor, r.action])));
  await sweep();
  check('...once per interval, not on every sweep', autoReminders(rem.id).length === 1);
  db.prepare('UPDATE documents SET last_reminded_at = ? WHERE id = ?').run(daysAgo(4), rem.id);
  await sweep();
  check('the next interval brings the next round', autoReminders(rem.id).length === 2);

  page = await text(head3, `/documents/${rem.id}`);
  check('the document page shows the schedule and the next round', page.includes('Automatic reminders') && page.includes('Next round'));
  await head3('POST', `/documents/${rem.id}/reminders`, form({ reminder_days: '0' }));
  db.prepare('UPDATE documents SET last_reminded_at = ? WHERE id = ?').run(daysAgo(30), rem.id);
  await sweep();
  check('turning them off stops them', docRow(rem.id).reminder_days === 0 && autoReminders(rem.id).length === 2, `reminder_days=${docRow(rem.id).reminder_days} rounds=${autoReminders(rem.id).length}`);
  check('...and the change is in the audit trail', !!db.prepare(`SELECT 1 FROM audit_events WHERE document_id = ? AND action = 'Automatic reminders changed'`).get(rem.id));
  check('another company cannot change them', (await owner('POST', `/documents/${rem.id}/reminders`, form({ reminder_days: '1' }))).status === 404 && docRow(rem.id).reminder_days === 0);

  // An interval must be shorter than the time allowed to sign.
  const draftWith = async (expires, reminder) => {
    const fd = new FormData();
    fd.append('pdf', new Blob([await pdf()], { type: 'application/pdf' }), 'e.pdf');
    fd.append('title', `Expires in ${expires}`); fd.append('expires_in_days', String(expires)); fd.append('reminder_days', String(reminder));
    fd.append('recipient_name', 'E'); fd.append('recipient_email', 'e@riverside.test');
    return (loc(await head3('POST', '/documents/new', { body: fd })).match(/documents\/([0-9a-f-]{36})/) || [])[1];
  };
  check('a 1-day expiry cannot have reminders every 3 days: they are turned off', docRow(await draftWith(1, 3)).reminder_days === 0);
  check('a 3-day expiry asking for weekly gets the longest that fits (every 2 days)', docRow(await draftWith(3, 7)).reminder_days === 2);
  check('an interval that fits is kept as chosen', docRow(await draftWith(30, 7)).reminder_days === 7);
  const shortDoc = await draftWith(2, 1);
  await head3('POST', `/documents/${shortDoc}/reminders`, form({ reminder_days: '7' }));
  check('the document page cannot set one longer than the document allows either', docRow(shortDoc).reminder_days === 1);

  // Signing order: only the person whose turn it is.
  const ofd = new FormData();
  ofd.append('pdf', new Blob([await pdf()], { type: 'application/pdf' }), 'o.pdf');
  ofd.append('title', 'In order'); ofd.append('signing_order', '1'); ofd.append('reminder_days', '1');
  for (const [n, e] of [['First', 'first@riverside.test'], ['Second', 'second@riverside.test']]) { ofd.append('recipient_name', n); ofd.append('recipient_email', e); }
  const ordId = (loc(await head3('POST', '/documents/new', { body: ofd })).match(/documents\/([0-9a-f-]{36})/) || [])[1];
  const firstRid = (await text(head3, `/documents/${ordId}/prepare`)).match(/data-id="([0-9a-f-]{36})"/)[1];
  await head3('PUT', `/api/documents/${ordId}/fields`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: [{ id: crypto.randomUUID(), type: 'signature', recipient_id: firstRid, page: 0, x: .2, y: .6, w: .3, h: .08 }] }) });
  await head3('POST', `/documents/${ordId}/send`);
  check('the chosen interval is kept', docRow(ordId).reminder_days === 1);
  db.prepare('UPDATE documents SET sent_at = ? WHERE id = ?').run(daysAgo(2), ordId);
  await sweep();
  rounds = autoReminders(ordId);
  check('with signing order on, only the person whose turn it is is reminded', rounds.length === 1 && rounds[0].recipient_id === firstRid, JSON.stringify(rounds.map((r) => r.recipient_id)));

  // Nothing in the trash, and nothing already signed, is chased.
  const quiet = await sendDoc(head3, 'Quiet please', 'Q', 'q@riverside.test');
  await head3('POST', `/documents/${quiet.id}/delete`);
  db.prepare('UPDATE documents SET sent_at = ? WHERE id = ?').run(daysAgo(10), quiet.id);
  const done = await sendDoc(head3, 'Already signed', 'D', 'd@riverside.test');
  await fetch(`${BASE}/sign/${done.tok}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true, values: { [done.fid]: PNG_DATA } }) });
  db.prepare('UPDATE documents SET sent_at = ? WHERE id = ?').run(daysAgo(10), done.id);
  await sweep();
  check('a trashed document is not chased', autoReminders(quiet.id).length === 0);
  check('a completed document is not chased', docRow(done.id).status === 'completed' && autoReminders(done.id).length === 0);

  console.log('\ndeleting a company');
  await owner('POST', '/platform/companies', form({ name: 'Doomed Ltd', admin_email: 'boss@doomed.test' }));
  const doomed = db.prepare(`SELECT * FROM companies WHERE name='Doomed Ltd'`).get();
  const dTok = db.prepare('SELECT token FROM invitations WHERE company_id = ?').get(doomed.id).token;
  const boss = session();
  await boss('POST', `/invite/${dTok}`, form({ display_name: 'Doomed Boss', password: 'boss-long-password', password_confirm: 'boss-long-password' }));
  const signed = await sendDoc(boss, 'Doomed Contract', 'Client', 'client@doomed.test');
  res = await fetch(`${BASE}/sign/${signed.tok}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ consent: true, values: { [signed.fid]: PNG_DATA } }) });
  const dDoc = db.prepare('SELECT * FROM documents WHERE id = ?').get(signed.id);
  check('setup: a sealed document with files on disk', dDoc.status === 'completed' && fs.existsSync(dDoc.original_path) && fs.existsSync(dDoc.sealed_path));
  await upload(owner, `/platform/companies/${doomed.id}/logo`, logoPng);
  const doomedLogo = db.prepare('SELECT logo_path FROM companies WHERE id = ?').get(doomed.id).logo_path;
  const riversideDocsBefore = db.prepare('SELECT COUNT(*) n FROM documents WHERE company_id = ?').get(riverside.id).n;

  await owner('POST', `/platform/companies/${doomed.id}/delete`, form({ confirm_name: 'Doomed Ltd' }));
  check('refused while the company is still active', !!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(doomed.id));
  await owner('POST', `/platform/companies/${doomed.id}/status`, form({ status: 'suspended' }));
  check('the page offers deletion once suspended', (await text(owner, `/platform/companies/${doomed.id}`)).includes('Delete permanently'));
  await owner('POST', `/platform/companies/${doomed.id}/delete`, form({ confirm_name: 'doomed ltd' }));
  check('refused when the typed name does not match exactly', !!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(doomed.id));
  // A fresh session: the earlier suspension test signed the old one out.
  const head2 = session();
  await signIn(head2, 'head@riverside.test', 'head-long-password');
  check('a company admin cannot delete a company', (await head2('POST', `/platform/companies/${doomed.id}/delete`, form({ confirm_name: 'Doomed Ltd' }))).status === 404
    && !!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(doomed.id));
  await owner('POST', `/platform/companies/${protea.id}/status`, form({ status: 'suspended' }));
  await owner('POST', `/platform/companies/${protea.id}/delete`, form({ confirm_name: 'Protea Heights Academy' }));
  check('the platform owner\'s own company can never be deleted', !!db.prepare('SELECT 1 FROM companies WHERE id = ?').get(protea.id)
    && !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(luan.id));
  await owner('POST', `/platform/companies/${protea.id}/status`, form({ status: 'active' }));

  res = await owner('POST', `/platform/companies/${doomed.id}/delete`, form({ confirm_name: 'Doomed Ltd' }));
  check('deleted, back to the company list', loc(res) === '/platform' && !db.prepare('SELECT 1 FROM companies WHERE id = ?').get(doomed.id));
  const left = (sql) => db.prepare(sql).get(doomed.id).n;
  check('its people, documents, invitations and log are gone',
    left('SELECT COUNT(*) n FROM users WHERE company_id = ?') === 0 &&
    left('SELECT COUNT(*) n FROM documents WHERE company_id = ?') === 0 &&
    left('SELECT COUNT(*) n FROM invitations WHERE company_id = ?') === 0 &&
    left('SELECT COUNT(*) n FROM admin_events WHERE company_id = ?') === 0);
  check('...with the recipients, fields and audit trail of its documents',
    db.prepare('SELECT COUNT(*) n FROM recipients WHERE document_id = ?').get(signed.id).n === 0 &&
    db.prepare('SELECT COUNT(*) n FROM fields WHERE document_id = ?').get(signed.id).n === 0 &&
    db.prepare('SELECT COUNT(*) n FROM audit_events WHERE document_id = ?').get(signed.id).n === 0);
  check('its PDFs are removed from disk', !fs.existsSync(dDoc.original_path) && !fs.existsSync(dDoc.sealed_path));
  check('...and its logo', !!doomedLogo && !fs.existsSync(doomedLogo));
  res = await signIn(session(), 'boss@doomed.test', 'boss-long-password');
  check('its people can no longer sign in', res.status === 401);
  check('its signing links and verification are gone', (await fetch(`${BASE}/sign/${signed.tok}`)).status === 404 && (await fetch(`${BASE}/verify/${signed.id}`)).status === 404);
  check('other companies are untouched', db.prepare('SELECT COUNT(*) n FROM documents WHERE company_id = ?').get(riverside.id).n === riversideDocsBefore
    && db.prepare('SELECT status FROM companies WHERE id = ?').get(riverside.id).status === 'active');
  const del = db.prepare(`SELECT * FROM admin_events WHERE company_id IS NULL AND action = 'Company deleted'`).get();
  check('the platform log keeps a record of what was deleted', del?.subject === 'Doomed Ltd' && /1 account\(s\), 1 document\(s\)/.test(del.detail), del?.detail);

  console.log('\nplatform owners without a company');
  await owner('POST', '/platform/owners/invite', form({ email: 'Ops@Platform.test' }));
  const oInv = db.prepare(`SELECT * FROM invitations WHERE email = 'ops@platform.test'`).get();
  check('a platform-owner invitation belongs to no company', oInv?.role === 'platform' && oInv.company_id === null);
  check('its page says what they are joining', (await (await fetch(`${BASE}/invite/${oInv.token}`)).text()).includes('platform owner'));
  const ops = session();
  res = await ops('POST', `/invite/${oInv.token}`, form({ display_name: 'Platform Ops', password: 'ops-long-password', password_confirm: 'ops-long-password' }));
  const opsUser = db.prepare(`SELECT * FROM users WHERE email = 'ops@platform.test'`).get();
  check('accepting creates an owner in no company, landing on the platform', loc(res) === '/platform' && opsUser.company_id === null && opsUser.platform_admin === 1);
  const sendsHome = async (url) => loc(await ops('GET', url)) === '/platform';
  check('company pages send them to the platform instead',
    (await sendsHome('/dashboard')) && (await sendsHome('/documents')) && (await sendsHome('/templates')) && (await sendsHome('/team')) && (await sendsHome('/settings')) && (await sendsHome('/documents/new')));
  res = await ops('PUT', `/api/documents/${helped.id}/fields`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: [] }) });
  const apiBody = await res.json().catch(() => null);
  check('the placer\'s save API answers them with an explanation, not a redirect', res.status === 403 && /not in a company/.test(apiBody?.error || ''), `${res.status} ${JSON.stringify(apiBody)}`);
  res = await session()('PUT', `/api/documents/${helped.id}/fields`, { headers: { 'content-type': 'application/json' }, body: '{"fields":[]}' });
  check('...and a signed-out save gets a 401 it can show', res.status === 401 && !!(await res.json().catch(() => null))?.error);
  check('they can use in-app verification too', (await ops('GET', '/verification')).status === 200);
  check('their profile and the platform pages open', (await ops('GET', '/profile')).status === 200 && (await ops('GET', '/platform')).status === 200);
  const opsShell = await text(ops, '/platform');
  check('their sidebar has no company navigation', !opsShell.includes('href="/documents/new"') && !opsShell.includes('href="/templates"') && !opsShell.includes('action="/documents"'));
  check('they appear in no company\'s team', !(await text(owner, '/team')).includes('ops@platform.test'));
  await ops('POST', `${rPage}/support`, form({ user_id: headUser.id, reason: 'Owner without a company helping' }));
  check('they can still run support sessions', (await text(ops, '/dashboard')).includes('Platform support'));
  res = await ops('POST', '/support/exit');
  check('...and come back to the platform', loc(res).startsWith('/platform'));

  await ops('POST', `/platform/owners/${opsUser.id}/remove`);
  check('an owner cannot remove their own access', db.prepare('SELECT platform_admin, status FROM users WHERE id = ?').get(opsUser.id).status === 'active');
  await ops('POST', `/platform/owners/${luan.id}/remove`);
  const luanNow = db.prepare('SELECT * FROM users WHERE id = ?').get(luan.id);
  check('removing a company member\'s access keeps their company role', luanNow.platform_admin === 0 && luanNow.company_id === protea.id && luanNow.role === 'admin' && luanNow.status === 'active');
  check('...they lose the platform pages but keep their company', (await owner('GET', '/platform')).status === 404 && (await owner('GET', '/dashboard')).status === 200);
  check('their company is no longer protected from deletion', !(await text(ops, `/platform/companies/${protea.id}`)).includes('holds a platform owner'));
  check('removal is in the platform log', !!db.prepare(`SELECT 1 FROM admin_events WHERE company_id IS NULL AND action = 'Platform access removed' AND subject = 'luan@protea.test'`).get());

  await ops('POST', '/platform/owners/invite', form({ email: 'second@platform.test' }));
  const sTok = db.prepare(`SELECT token FROM invitations WHERE email = 'second@platform.test'`).get().token;
  await session()('POST', `/invite/${sTok}`, form({ display_name: 'Second Owner', password: 'second-long-password', password_confirm: 'second-long-password' }));
  const second = db.prepare(`SELECT * FROM users WHERE email = 'second@platform.test'`).get();
  await ops('POST', `/platform/owners/${second.id}/remove`);
  check('a company-less owner is deactivated rather than orphaned', db.prepare('SELECT status FROM users WHERE id = ?').get(second.id).status === 'suspended');
  check('...and cannot sign in', (await signIn(session(), 'second@platform.test', 'second-long-password')).status === 401);
  await ops('POST', `/platform/owners/${second.id}/restore`);
  check('...until restored', loc(await signIn(session(), 'second@platform.test', 'second-long-password')) === '/dashboard');
  db.close();
} catch (e) { fail++; console.error(e); }
finally {
  server.kill();
  const errs = log.split('\n').filter((l) => /Error/.test(l));
  if (errs.length) console.log('--- server errors ---\n' + errs.slice(0, 10).join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
