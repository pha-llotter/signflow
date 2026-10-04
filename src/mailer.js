import nodemailer from 'nodemailer';
import { decryptSecret } from './crypto.js';
import { config } from './config.js';
import { mailLogoAttachment } from './brand.js';
import { mailSettings, companyById } from './settings-store.js';
import { companyLogo, fitLogo } from './company-logo.js';
import { renderEmail, renderText, esc } from './email-template.js';

/**
 * Outgoing mail is chosen per company: its own server if an administrator set
 * one, otherwise the platform default. Members cannot reach Settings, so
 * per-user credentials would leave their invitations silently unable to send.
 *
 * Returns null when neither is configured — callers fall back to logging the
 * link so the flow still works before SMTP is set up.
 */
export function transport(companyId) {
  const s = mailSettings(companyId);
  if (!s) return null;
  return nodemailer.createTransport({
    host: s.smtp_host,
    port: s.smtp_port || 587,
    secure: !!s.smtp_secure,
    auth: s.smtp_user ? { user: s.smtp_user, pass: decryptSecret(s.smtp_pass_enc) || '' } : undefined,
  });
}

/**
 * One envelope address per mail account, because most mail servers reject a
 * From they do not own — but the display name is the person actually sending,
 * so a recipient sees a name they recognise.
 */
export function fromAddress(sender, companyId = sender?.company_id) {
  const s = mailSettings(companyId);
  const email = s?.from_email || s?.smtp_user || sender?.email;
  const name = sender?.display_name || s?.from_name || config.brand.name;
  return `"${String(name).replace(/"/g, '')}" <${email}>`;
}

export async function verifySmtp(companyId) {
  const t = transport(companyId);
  if (!t) throw new Error('Outgoing mail has not been configured yet.');
  await t.verify();
  return true;
}

/**
 * Sends if SMTP is configured, otherwise logs. Never throws into the request
 * path — a mail failure must not lose a document that is already recorded as
 * sent; it is reported back to the sender instead.
 *
 * Goes out through the sender's company unless `companyId` says otherwise —
 * the platform owner inviting a new company's administrator must use that
 * company's mail, not their own.
 */
export async function send(sender, { to, subject, html, text, attachments }, { companyId = sender?.company_id } = {}) {
  const t = transport(companyId);
  if (!t) {
    console.log(`\n[mail:not-configured] to=${to}\n  subject=${subject}\n  ${text?.split('\n').join('\n  ')}\n`);
    return { delivered: false, reason: 'Outgoing mail is not configured yet' };
  }
  ({ html, attachments } = withCompanyLogo({ html, attachments }, companyId));
  try {
    const info = await t.sendMail({
      from: fromAddress(sender, companyId),
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
 * Puts the sending company's own logo at the top of its mail in place of the
 * platform's. Done here rather than in each message builder because only send()
 * knows which company a message goes out for, and every message carries the
 * same header image.
 *
 * Sized by height, not the 150px width the wordmark uses — a square crest at
 * that width would fill the screen. Mail without a company (platform mail,
 * or a company with no logo) is left exactly as it was.
 */
export function withCompanyLogo({ html, attachments }, companyId) {
  const logo = companyLogo(companyId);
  if (!logo || !html?.includes('cid:signflow-logo')) return { html, attachments };
  const name = esc(companyById(companyId)?.name || '');
  const { w, h } = fitLogo(logo.width, logo.height, 200, 56);
  return {
    html: html.replace(
      /<img src="cid:signflow-logo"[^>]*>/,
      `<img src="cid:company-logo" width="${w}" height="${h}" alt="${name}" style="display:block;border:0;outline:none;text-decoration:none;width:${w}px;height:${h}px;">`
    ),
    attachments: [
      ...(attachments || []).filter((a) => a.cid !== 'signflow-logo'),
      { filename: `logo.${logo.ext}`, content: logo.bytes, cid: 'company-logo', contentDisposition: 'inline' },
    ],
  };
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

/** `reminder` re-sends the same link, worded as a nudge rather than a first request. */
export function invitationEmail({ doc, recipient, sender, link, reminder = false }) {
  const who = `${esc(sender.display_name)}${sender.org_name ? ` (${esc(sender.org_name)})` : ''}`;
  const expires = doc.expires_at
    ? new Date(doc.expires_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  const panels = [{ label: 'Document', value: doc.title }];
  if (expires) panels.push({ label: 'Please sign before', value: expires });

  return compose({
    subject: reminder ? `Reminder — please sign: ${doc.title}` : `Please sign: ${doc.title}`,
    heading: reminder ? 'A reminder to sign' : 'You have a document to sign',
    paragraphs: [
      reminder
        ? `<strong>${who}</strong> sent you <strong>${esc(doc.title)}</strong> to sign, and it is still waiting for your signature.`
        : `<strong>${who}</strong> has sent you <strong>${esc(doc.title)}</strong> to review and sign.`,
      ...(doc.message ? [`<em>&ldquo;${esc(doc.message)}&rdquo;</em>`] : []),
      'You do not need an account. The link below opens the document in your browser and walks you through the fields addressed to you.',
    ],
    lines: [
      reminder
        ? `Reminder: ${sender.display_name}${sender.org_name ? ` (${sender.org_name})` : ''} sent you "${doc.title}" to sign, and it is still waiting for your signature.`
        : `${sender.display_name}${sender.org_name ? ` (${sender.org_name})` : ''} has sent you "${doc.title}" to review and sign.`,
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
  const org = companyById(invite.company_id)?.name;
  return compose({
    subject: `${inviter.display_name} has invited you to ${org || config.brand.name}`,
    heading: 'You have been invited',
    paragraphs: [
      invite.role === 'platform'
        ? `<strong>${esc(inviter.display_name)}</strong> has invited you to run ${esc(config.brand.name)} as a platform owner — creating and managing the organisations that use it.`
        : `<strong>${esc(inviter.display_name)}</strong> has invited you to send and manage documents on ${esc(org || config.brand.name)}.`,
      'Choose a password using the link below and your account is ready. Nothing else is needed.',
    ],
    lines: [
      `${inviter.display_name} has invited you to ${org || config.brand.name}.`,
      'Use the link below to choose a password and finish setting up your account.',
    ],
    cta: { label: 'Accept the invitation', url: link },
    panels: [
      { label: 'Your sign-in email', value: invite.email },
      { label: 'Role', value: invite.role === 'platform' ? 'Platform owner' : invite.role === 'admin' ? 'Administrator' : 'Member' },
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

export function smtpTestEmail({ user, companyId = user.company_id }) {
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
      const s = mailSettings(companyId);
      return [
        { label: 'Sending as', value: fromAddress(user, companyId) },
        { label: 'Replies go to', value: user.email },
        { label: 'SMTP server', value: `${s.smtp_host}:${s.smtp_port || 587}${s.smtp_secure ? ' (TLS)' : ' (STARTTLS)'}` },
      ];
    })(),
    note: 'This applies to everyone who sends through this mail account, not just you. You can send the test again at any time from Settings.',
  });
}
