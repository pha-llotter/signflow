/**
 * Access-control tests for the invitation-only account model.
 *
 *   npm run admin-check
 *
 * Covers the things that are quietly catastrophic if they regress: a member
 * reaching admin pages, a revoked invitation still working, the installation
 * being left with no administrator, and a deactivated account keeping its
 * session.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'signflow-admin-'));
const PORT = 3993;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const check = (label, ok, extra = '') => {
  if (ok) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${extra ? `\n          ${extra}` : ''}`); }
};

/** Each named session is an independent browser with its own cookie jar. */
function session() {
  const jar = new Map();
  return {
    jar,
    async req(method, url, { body, headers = {}, redirect = 'manual' } = {}) {
      const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + url, {
        method, redirect,
        headers: { ...(jar.size ? { cookie } : {}), ...headers },
        body,
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return res;
    },
  };
}

const form = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) for (const i of [].concat(v)) p.append(k, String(i));
  return { body: p, headers: { 'content-type': 'application/x-www-form-urlencoded' } };
};

/**
 * Returns the whole <tr> containing an address. Splitting on the email and
 * taking one side is not good enough — the action forms sit after the name cell
 * but before the next row, so a naive split silently returns the neighbouring
 * row's ids and the test then asserts against the wrong account.
 */
// slice(1): the page head before the first row also carries the signed-in
// user's email (the account menu), and must not be mistaken for their row.
const rowFor = (html, email) => html.split('<tr').slice(1).find((r) => r.includes(email)) || '';

const server = spawn(process.execPath, ['src/server.js'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env, NODE_ENV: 'development', PORT: String(PORT), BASE_URL: BASE,
    STORAGE_DIR: TMP, DB_PATH: path.join(TMP, 'admin.db'),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    APP_KEY: crypto.randomBytes(32).toString('hex'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let ok = false;
try {
  for (let i = 0; i < 120; i++) {
    try { await fetch(`${BASE}/login`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }

  console.log('\nAdmin / access-control check\n');

  // --- first run -----------------------------------------------------------
  const admin = session();
  const adminEmail = `admin-${Date.now()}@example.test`;

  let res = await admin.req('GET', '/register');
  check('first run offers registration', res.status === 200);

  res = await admin.req('POST', '/register', form({
    email: adminEmail, display_name: 'The Administrator',
    org_name: 'Protea Heights Academy', password: 'a-long-enough-password',
  }));
  check('the first account is created and lands on the team page',
    res.status === 302 && res.headers.get('location') === '/team',
    `${res.status} → ${res.headers.get('location')}`);

  res = await admin.req('GET', '/team');
  const teamHtml = await res.text();
  check('the first account is an administrator', res.status === 200 && /\badmin\b/i.test(teamHtml));

  // --- registration is now closed -----------------------------------------
  const stranger = session();
  res = await stranger.req('GET', '/register');
  check('public registration closes after the first account',
    res.status === 302 && res.headers.get('location') === '/login',
    `${res.status} → ${res.headers.get('location')}`);

  res = await stranger.req('POST', '/register', form({
    email: `sneaky-${Date.now()}@example.test`, display_name: 'Sneaky', password: 'another-long-password',
  }));
  check('registration cannot be forced by posting directly',
    res.status === 302 && res.headers.get('location') === '/login');

  // --- invitations ---------------------------------------------------------
  const memberEmail = `member-${Date.now()}@example.test`;
  await admin.req('POST', '/team/invite', form({ email: memberEmail, role: 'member' }));

  res = await admin.req('GET', '/team');
  const withInvite = await res.text();
  const inviteToken = withInvite.match(/\/invite\/([A-Za-z0-9_-]{40,})/)?.[1];
  check('an invitation is created with a link', !!inviteToken);

  res = await admin.req('POST', '/team/invite', form({ email: adminEmail, role: 'member' }));
  const dupeHtml = await (await admin.req('GET', '/team')).text();
  check('inviting an existing account is refused', /already has an account/i.test(dupeHtml));

  // --- accepting -----------------------------------------------------------
  const member = session();
  res = await member.req('GET', `/invite/${inviteToken}`);
  check('the invitation link opens without an account', res.status === 200);

  res = await member.req('POST', `/invite/${inviteToken}`, form({
    display_name: 'A Member', password: 'member-long-password', password_confirm: 'member-long-password',
  }));
  check('accepting the invitation creates the account',
    res.status === 302 && res.headers.get('location') === '/dashboard',
    `${res.status} → ${res.headers.get('location')}`);

  res = await member.req('GET', `/invite/${inviteToken}`);
  check('a used invitation cannot be replayed', res.status === 410);

  // --- what a member may not reach ----------------------------------------
  for (const url of ['/team', '/settings']) {
    res = await member.req('GET', url);
    check(`a member gets 404 on ${url}`, res.status === 404, `got ${res.status}`);
  }
  res = await member.req('POST', '/settings', form({ smtp_host: 'evil.example.com' }));
  check('a member cannot post installation settings', res.status === 404, `got ${res.status}`);

  res = await member.req('POST', '/team/invite', form({ email: 'x@example.test', role: 'admin' }));
  check('a member cannot invite anyone', res.status === 404, `got ${res.status}`);

  res = await member.req('GET', '/profile');
  check('a member can reach their own profile', res.status === 200);

  // --- the last-administrator guard ---------------------------------------
  res = await admin.req('GET', '/team');
  const teamPage = await res.text();
  const adminId = rowFor(teamPage, adminEmail).match(/\/team\/user\/([0-9a-f-]{36})\/role/)?.[1];
  check('the team page exposes the admin row', !!adminId);

  await admin.req('POST', `/team/user/${adminId}/role`, form({ role: 'member' }));
  let after = await (await admin.req('GET', '/team')).text();
  check('the only administrator cannot demote themselves',
    /only administrator/i.test(after), 'no guard message found');

  res = await admin.req('GET', '/settings');
  check('the administrator still has admin access after the blocked demotion', res.status === 200);

  // --- revoking ------------------------------------------------------------
  const revokeEmail = `revoked-${Date.now()}@example.test`;
  await admin.req('POST', '/team/invite', form({ email: revokeEmail, role: 'member' }));
  let page = await (await admin.req('GET', '/team')).text();
  const revokeRow = rowFor(page, revokeEmail);
  const revokeId = revokeRow.match(/\/team\/invite\/([0-9a-f-]{36})\/revoke/)?.[1];
  const revokeToken = revokeRow.match(/\/invite\/([A-Za-z0-9_-]{40,})/)?.[1];

  if (revokeId && revokeToken) {
    await admin.req('POST', `/team/invite/${revokeId}/revoke`);
    res = await session().req('GET', `/invite/${revokeToken}`);
    check('a withdrawn invitation stops working', res.status === 410, `got ${res.status}`);
  } else {
    check('a withdrawn invitation stops working', false, 'could not locate the invitation row');
  }

  // --- deactivation --------------------------------------------------------
  page = await (await admin.req('GET', '/team')).text();
  const memberId = rowFor(page, memberEmail).match(/\/team\/user\/([0-9a-f-]{36})\/role/)?.[1];
  check('the team page exposes the member row', !!memberId);
  check('the member row is not the administrator row', memberId && memberId !== adminId,
    `member ${memberId} vs admin ${adminId}`);

  res = await member.req('GET', '/documents');
  check('the member has a working session before deactivation', res.status === 200);

  await admin.req('POST', `/team/user/${memberId}/status`, form({ status: 'suspended' }));

  res = await member.req('GET', '/documents');
  const bounced = res.headers.get('location') || '';
  check('deactivating ends the live session immediately',
    res.status === 302 && bounced.startsWith('/login'),
    `${res.status} → ${bounced}`);
  // Being silently bounced to a login form looks like a bug; say what happened.
  check('the bounced user is told their account was deactivated',
    bounced.includes('deactivated'), bounced);

  res = await member.req('POST', '/login', form({ email: memberEmail, password: 'member-long-password' }));
  const loginHtml = await res.text();
  check('a deactivated account is told why it cannot sign in',
    res.status === 401 && /deactivated/i.test(loginHtml));

  await admin.req('POST', `/team/user/${memberId}/status`, form({ status: 'active' }));
  const restored = session();
  res = await restored.req('POST', '/login', form({ email: memberEmail, password: 'member-long-password' }));
  check('restoring an account lets them sign in again',
    res.status === 302 && res.headers.get('location') === '/dashboard',
    `${res.status} → ${res.headers.get('location')}`);

  // --- password reset ------------------------------------------------------
  await admin.req('POST', `/team/user/${memberId}/reset`);
  const resetPage = await (await admin.req('GET', '/team')).text();
  const resetToken = resetPage.match(/\/reset\/([A-Za-z0-9_-]{40,})/)?.[1]
    || log.match(/\/reset\/([A-Za-z0-9_-]{40,})/)?.[1];
  check('a reset link is issued', !!resetToken, 'no reset token found in the flash or the mail log');

  if (resetToken) {
    const resetter = session();
    res = await resetter.req('POST', `/reset/${resetToken}`, form({
      password: 'brand-new-password-1', password_confirm: 'brand-new-password-1',
    }));
    check('the reset link sets a new password and signs in',
      res.status === 302 && res.headers.get('location') === '/dashboard',
      `${res.status} → ${res.headers.get('location')}`);

    res = await session().req('GET', `/reset/${resetToken}`);
    check('a used reset link cannot be replayed', res.status === 410, `got ${res.status}`);

    res = await session().req('POST', '/login', form({ email: memberEmail, password: 'member-long-password' }));
    check('the old password stops working after a reset', res.status === 401);
  }

  // --- the admin log -------------------------------------------------------
  const activity = await (await admin.req('GET', '/activity')).text();
  for (const entry of ['Invitation sent', 'Account deactivated', 'Password reset issued']) {
    check(`the activity log records "${entry}"`, activity.includes(entry));
  }
  // The session that signed back in after the account was restored — the
  // original one was cut off by the deactivation, as it should be.
  res = await restored.req('GET', '/activity');
  check('a member cannot reach the activity log', res.status === 404, String(res.status));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  ok = failed === 0;
} catch (err) {
  console.error('\nadmin-check crashed:', err.message);
  if (log) console.error('\n--- server output ---\n' + log);
} finally {
  server.kill();
  await new Promise((r) => (server.exitCode === null ? server.once('exit', r) : r()));
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 120 }); } catch {}
}

process.exit(ok ? 0 : 1);
