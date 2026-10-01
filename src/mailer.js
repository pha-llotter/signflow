import nodemailer from 'nodemailer';
import { decryptSecret } from './crypto.js';
import { config } from './config.js';
import { mailLogoAttachment } from './brand.js';
import { appSettings } from './settings-store.js';
import { renderEmail, renderText, esc } from './email-template.js';

/**
 * Outgoing mail is configured once for the whole installation, by an admin.
 * Members cannot reach Settings, so per-user credentials would leave their
 * invitations silently unable to send.
 *
 * Returns null when mail has not been configured yet — callers fall back to
 * logging the link so the flow still works before SMTP is set up.
 */
export function transport() {
  const s = appSettings();
  if (!s?.smtp_host) return null;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port || 587,
    secure: !!s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: decryptSecret(s.smtp_pass_enc) || '' } : undefined,
  });
}

/**
 * One envelope address for the whole installation, because most mail servers
 * reject a From they do not own — but the display name is the person actually
 * sending, so a recipient sees a name they recognise.
 */
export function fromAddress(sender) {
  const s = appSettings();
  const email = s?.from_email || s?.smtp_user || sender?.email;
  const name = sender?.display_name || s?.from_name || config.brand.name;
  return `"${String(name).replace(/"/g, '')}" <${email}>`;
}

export async function verifySmtp() {
  const t = transport();
  if (!t) throw new Error('Outgoing mail has not been configured yet.');
  await t.verify();
  return true;
}

/**
 * Sends if SMTP is configured, otherwise logs. Never throws into the request
 * path — a mail failure must not lose a document that is already recorded as
 * sent; it is reported back to the sender instead.
 */
export async function send(sender, { to, subject, html, text, attachments }) {
  const t = transport();
  if (!t) {
    console.log(`\n[mail:not-configured] to=${to}\n  subject=${subject}\n  ${text?.split('\n').join('\n  ')}\n`);
    return { delivered: false, reason: 'Outgoing mail is not configured yet' };
  }
  try {
    const info = await t.sendMail({
      from: fromAddress(sender),
      // Replies go to the person who sent the document, not the shared mailbox.
      replyTo: sender?.email ? `"${String(sender.display_name || '').replace(/"/g, '')}" <${sender.email}>` : undefined,
      to, subject, html, text, attachments,
    });
    return { delivered: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[mail:failed] to=${to}: ${err.message}`);
    return { delivered: false, reason: err.message };
  }
}

/**
 * The logo travels as an inline (cid:) part rather than a hosted URL. Most
 * clients block remote images by default, and a signing invitation that arrives
 * with a broken image where the brand should be reads like a phishing attempt.
 */
function brandAssets() {
  const attachment = mailLogoAttachment();
  return { hasLogo: !!attachment, attachments: attachment ? [attachment] : [] };
}

/** Wraps the shared layout so each message only describes its own content. */
function compose({ subject, heading, paragraphs, lines, cta, panels, note, attachments = [] }) {
  const brand = brandAssets();
  return {
    subject,
    html: renderEmail({ heading, paragraphs, cta, panels, note, hasLogo: brand.hasLogo }),
    text: renderText({ heading, lines, cta, panels, note }),
    attachments: [...brand.attachments, ...attachments],
  };
}

export function invitationEmail({ doc, recipient, sender, link }) {
  const who = `${esc(sender.display_name)}${sender.org_name ? ` (${esc(sender.org_name)})` : ''}`;
  const expires = doc.expires_at
    ? new Date(doc.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  const panels = [{ label: 'Document', value: doc.title }];
  if (expires) panels.push({ label: 'Please sign before', value: expires });

  return compose({
    subject: `Please sign: ${doc.title}`,
    heading: 'You have a document to sign',
    paragraphs: [
      `<strong>${who}</strong> has sent you <strong>${esc(doc.title)}</strong> to review and sign.`,
      ...(doc.message ? [`<em>&ldquo;${esc(doc.message)}&rdquo;</em>`] : []),
      'You do not need an account. The link below opens the document in your browser and walks you through the fields addressed to you.',
    ],
    lines: [
      `${sender.display_name}${sender.org_name ? ` (${sender.org_name})` : ''} has sent you "${doc.title}" to review and sign.`,
      ...(doc.message ? ['', `"${doc.message}"`] : []),
      '',
      'You do not need an account — the link below opens it in your browser.',
    ],
    cta: { label: 'Review & sign', url: link },
    panels,
    note:
      'This link is unique to you, so please do not forward it — anyone holding it can sign in your name. ' +
      'Signing records your name, email, IP address and the time of each step as evidence that you signed.',
  });
}

export function completionEmail({ doc, sender, downloadUrl, attachment }) {
  return compose({
    subject: `Signed & sealed: ${doc.title}`,
    heading: 'Document completed',
    paragraphs: [
      `Good news &mdash; <strong>${esc(doc.title)}</strong> has been signed by everyone. Your final signed copy, with its certificate of completion, is attached and ready to download below.`,
    ],
    lines: [`"${doc.title}" has been signed by everyone.`, '', 'The sealed PDF and its certificate of completion are attached.'],
    cta: downloadUrl ? { label: 'Download signed copy', url: downloadUrl } : undefined,
    panels: [
      { label: 'Sealed document SHA-256', value: doc.sealed_sha256 || '—', mono: true },
      { label: 'Verify this document at', value: `${config.baseUrl}/verify/${doc.id}` },
    ],
    note:
      'The hash above is a fingerprint of the exact file. Anyone can check a copy against it on the verification page &mdash; ' +
      'if a single byte changes, it will no longer match.',
    attachments: attachment ? [attachment] : [],
  });
}

export function declinedEmail({ doc, recipient, reason }) {
  return compose({
    subject: `Declined: ${doc.title}`,
    heading: 'A recipient declined to sign',
    paragraphs: [
      `<strong>${esc(recipient.name)}</strong> (${esc(recipient.email)}) declined to sign <strong>${esc(doc.title)}</strong>.`,
      'The document is now closed and no further signatures can be added to it.',
    ],
    lines: [
      `${recipient.name} <${recipient.email}> declined to sign "${doc.title}".`,
      'The document is now closed.',
    ],
    cta: { label: 'Open the document', url: `${config.baseUrl}/documents/${doc.id}` },
    panels: reason ? [{ label: 'Reason given', value: reason }] : [],
  });
}

export function invitationToJoinEmail({ invite, inviter, link, expiresAt }) {
  const org = appSettings()?.org_name;
  return compose({
    subject: `${inviter.display_name} has invited you to ${org || config.brand.name}`,
    heading: 'You have been invited',
    paragraphs: [
      `<strong>${esc(inviter.display_name)}</strong> has invited you to send and manage documents on ${esc(org || config.brand.name)}.`,
      'Choose a password using the link below and your account is ready. Nothing else is needed.',
    ],
    lines: [
      `${inviter.display_name} has invited you to ${org || config.brand.name}.`,
      'Use the link below to choose a password and finish setting up your account.',
    ],
    cta: { label: 'Accept the invitation', url: link },
    panels: [
      { label: 'Your sign-in email', value: invite.email },
      { label: 'Role', value: invite.role === 'admin' ? 'Administrator' : 'Member' },
      {
        label: 'Invitation expires',
        value: new Date(expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      },
    ],
    note: 'If you were not expecting this, you can ignore it — the invitation expires on its own and nothing is created until you use it.',
  });
}

export function passwordResetEmail({ user, issuer, link, expiresAt }) {
  return compose({
    subject: 'Set a new password',
    heading: 'Set a new password',
    paragraphs: [
      `<strong>${esc(issuer.display_name)}</strong> has issued a password reset for your account. Use the link below to choose a new one.`,
      'Your existing password stops working the moment the new one is set.',
    ],
    lines: [
      `${issuer.display_name} has issued a password reset for your account.`,
      'Use the link below to choose a new one.',
    ],
    cta: { label: 'Choose a new password', url: link },
    panels: [
      { label: 'Account', value: user.email },
      {
        label: 'Link expires',
        value: new Date(expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      },
    ],
    note: 'If you did not ask for this, tell your administrator — someone with access to the account settings issued it.',
  });
}

export function smtpTestEmail({ user }) {
  return compose({
    subject: `${config.brand.name} — outgoing mail is working`,
    heading: 'Your mail settings work',
    paragraphs: [
      'This is a test from your account settings. If you are reading it, signing invitations, reminders and completion notices will reach your recipients.',
      'Everything goes out from the address below, so your signers see a name they recognise and replies come back to you.',
    ],
    lines: [
      'This is a test from your account settings.',
      'If you are reading it, invitations and reminders will reach your recipients.',
    ],
    cta: { label: 'Send a document', url: `${config.baseUrl}/documents/new` },
    panels: (() => {
      const s = appSettings();
      return [
        { label: 'Sending as', value: fromAddress(user) },
        { label: 'Replies go to', value: user.email },
        { label: 'SMTP server', value: `${s.smtp_host}:${s.smtp_port || 587}${s.smtp_secure ? ' (TLS)' : ' (STARTTLS)'}` },
      ];
    })(),
    note: 'This applies to everyone on this installation, not just your account. You can send the test again at any time from Settings.',
  });
}
