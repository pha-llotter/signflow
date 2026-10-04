/**
 * "Copy link" buttons: any element with class copy-link and a data-link.
 *
 * navigator.clipboard exists only in a secure context — HTTPS or localhost —
 * so on a plain-http LAN address it is undefined and the button used to throw
 * and do nothing. The older execCommand route works there; if even that is
 * refused, the link is put in front of the person to copy by hand rather than
 * lost.
 */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

document.querySelectorAll('.copy-link').forEach((b) => {
  b.addEventListener('click', async () => {
    const ok = await copyText(b.dataset.link).catch(() => false);
    if (!ok) {
      window.prompt('Copy this link:', b.dataset.link);
      return;
    }
    const was = b.textContent;
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = was; }, 1400);
  });
});
