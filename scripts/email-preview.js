/**
 * Renders every email the app sends to HTML and screenshots each one, so the
 * templates can be reviewed without configuring SMTP and sending real mail.
 *
 *   node scripts/email-preview.js [outDir]
 *
 * The cid: logo has no meaning outside a mail client, so it is swapped for a
 * data: URI here. That is the only difference from what actually goes out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { config } from '../src/config.js';
import { logoBytes } from '../src/brand.js';
import { db } from '../src/db.js';
import {
  invitationEmail, completionEmail, declinedEmail, smtpTestEmail,
  invitationToJoinEmail, passwordResetEmail,
} from '../src/mailer.js';

// The templates read installation settings, so give the preview something
// realistic to render rather than blanks.
db.prepare(
  `UPDATE app_settings SET org_name = ?, smtp_host = ?, smtp_port = 587, smtp_secure = 0,
     smtp_user = ?, from_email = ?, from_name = ? WHERE id = 1`
).run('Protea Heights Academy', 'smtp.office365.com', 'llotter@phahs.org.za', 'noreply@phahs.org.za', 'Protea Heights Academy');

const OUT = process.argv[2] || path.resolve(import.meta.dirname, '..', 'email-preview');
fs.mkdirSync(OUT, { recursive: true });

const owner = {
  display_name: 'Luan Lötter',
  org_name: 'Protea Heights Academy',
  email: 'llotter@phahs.org.za',
  smtp_host: 'smtp.office365.com',
  smtp_port: 587,
  smtp_secure: 0,
  smtp_user: 'llotter@phahs.org.za',
  smtp_from_name: 'Luan Lötter',
  smtp_from_email: 'llotter@phahs.org.za',
};

const doc = {
  id: 'cfb41941-5813-491d-962f-05f9c830b9f5',
  title: 'ICT Policy',
  message: 'Please read the policy in full before signing. Ask me if anything is unclear.',
  expires_at: new Date(Date.now() + 30 * 864e5).toISOString(),
  sealed_sha256: '15cef351fdcc6069ca3c9aab0a21d1b8dcb174f27cdc067d0e58845bd6dd331a',
};

const recipient = { name: 'Luan Test', email: 'llotter@phahs.org.za' };

const inWeek = new Date(Date.now() + 7 * 864e5).toISOString();
const inDay = new Date(Date.now() + 864e5).toISOString();

const emails = [
  ['1-invitation', invitationEmail({ doc, recipient, sender: owner, link: `${config.baseUrl}/sign/Qk9x7f2mZp4LrT8vN1sWqYcHgE5dJ3aB6uXoI0tKpMw` })],
  ['2-completed', completionEmail({ doc, sender: owner, downloadUrl: `${config.baseUrl}/documents/${doc.id}/signed.pdf` })],
  ['3-declined', declinedEmail({ doc, recipient, reason: 'I need the acceptable-use section clarified first.' })],
  ['4-smtp-test', smtpTestEmail({ user: owner })],
  ['5-join', invitationToJoinEmail({
    invite: { email: 'newteacher@phahs.org.za', role: 'member' },
    inviter: owner,
    link: `${config.baseUrl}/invite/8tGkP2vRmXqL4wZnB7sJdYhCfE1aU6oI3rTyN0KpQwM`,
    expiresAt: inWeek,
  })],
  ['6-password-reset', passwordResetEmail({
    user: { email: 'newteacher@phahs.org.za' },
    issuer: owner,
    link: `${config.baseUrl}/reset/Lp9XnV2mQ8zWtR4sKdJ7yHbCfA1eU5oI6rTgN3wYqEs`,
    expiresAt: inDay,
  })],
];

// Swap the cid: reference for a data: URI so the preview renders standalone.
const bytes = logoBytes('web');
const dataUri = bytes ? `data:image/png;base64,${bytes.toString('base64')}` : '';

const browser = await chromium.launch({ channel: 'msedge', headless: true });

for (const [name, mail] of emails) {
  const html = mail.html.replaceAll('cid:signflow-logo', dataUri);
  const file = path.join(OUT, `${name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), mail.text, 'utf8');

  for (const [variant, width] of [['', 900], ['-mobile', 390]]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: path.join(OUT, `${name}${variant}.png`), fullPage: true });
    await page.close();
  }

  console.log(`  ${name.padEnd(14)} subject: ${mail.subject}`);
  console.log(`  ${''.padEnd(14)} parts:   ${mail.attachments.length} attachment(s), ${mail.text.split('\n').length} text lines`);
}

await browser.close();
console.log(`\n${emails.length} emails → ${OUT}\n`);
