/**
 * The signing page.
 *
 * Renders the document as the author laid it out, overlays only the fields
 * addressed to this signer as fillable, and collects their answers.
 *
 * The flow is three popups around a full-width document: a welcome that takes
 * consent before anything can be filled in, the document itself guided by a
 * Next field button, and a confirmation on Finish. Nothing is committed until
 * that confirmation — and the server re-checks consent and every required
 * field, so all of this is convenience, not the control.
 */
import * as pdfjsLib from '/static/vendor/pdfjs/pdf.min.mjs';
import { openSignaturePad, openDrawingPad } from '/static/js/signature-pad.js';
import { createThumbs } from '/static/js/page-thumbs.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';

const S = window.__SIGN__;
const BASE_WIDTH = 860;

const values = {};   // field id -> value going to the server
const files = {};    // field id -> { name, mime, dataUrl } for attachment fields
let pageEls = [];
let pdfDoc = null;
let thumbs = null;

const el = {
  pages: document.getElementById('pages'),
  doneCount: document.getElementById('done-count'),
  consent: document.getElementById('consent'),
  finish: document.getElementById('finish-btn'),
  next: document.getElementById('next-btn'),
  error: document.getElementById('sign-error'),
  welcome: document.getElementById('welcome'),
  welcomeContinue: document.getElementById('welcome-continue'),
};

// Consent is given once, in the welcome popup, and carried to the submit.
let consented = false;

const myFields = S.fields.filter(
  (f) => f.recipient_id === S.recipientId && S.fieldTypes[f.type].fill === 'signer'
);

/* ------------------------------------------------------------------ render */

async function render() {
  // Loaded once; a resize only lays the pages out again.
  pdfDoc ??= await pdfjsLib.getDocument({ url: S.pdfUrl, withCredentials: true }).promise;
  const pdf = pdfDoc;
  el.pages.innerHTML = '';
  pageEls = [];

  // Measure the column the pages actually get — beside the pages pane on a
  // wide screen, the whole width on a phone — rather than assuming it.
  const inner = el.pages.clientWidth;
  const available = Math.max(240, Math.min(inner, BASE_WIDTH));

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: available / natural.width });

    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.dataset.page = String(i);
    holder.style.width = `${viewport.width}px`;
    holder.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    holder.appendChild(canvas);
    el.pages.appendChild(holder);
    pageEls.push(holder);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  drawFields();

  // The pages pane beside the document: where this signer's fields are, and
  // which are still to do.
  const list = document.getElementById('sign-thumbs');
  if (!thumbs && list) {
    thumbs = createThumbs({
      pdf, list, scroller: () => document.documentElement, pageEls: () => pageEls,
      markClass: (f) => (f.mine ? (f.done ? 'done' : 'todo') : 'theirs'),
    });
    thumbs.build().then(markThumbs);
  }
}

function markThumbs() {
  thumbs?.mark(S.fields
    .filter((f) => !['label', 'hyperlink', 'qrcode', 'stamp'].includes(f.type))
    .map((f) => {
      // The signer's own automatic fields (name, date) fill themselves, so they count as done.
      const own = f.recipient_id === S.recipientId;
      return { ...f, mine: own, done: myFields.includes(f) ? isFilled(f) : own };
    }));
}

function drawFields() {
  pageEls.forEach((p) => p.querySelectorAll('.sfld').forEach((n) => n.remove()));

  for (const f of S.fields) {
    const holder = pageEls[f.page];
    if (!holder) continue;
    if (f.type === 'label' || f.type === 'hyperlink' || f.type === 'qrcode' || f.type === 'stamp') continue;

    const mine = f.recipient_id === S.recipientId;
    const spec = S.fieldTypes[f.type];
    const fillable = mine && spec.fill === 'signer';

    const node = document.createElement('div');
    node.className = 'sfld ' + (fillable ? 'mine' : 'theirs') + (values[f.id] ? ' done' : '');
    node.dataset.id = f.id;
    node.style.left = `${f.x * 100}%`;
    node.style.top = `${f.y * 100}%`;
    node.style.width = `${f.w * 100}%`;
    node.style.height = `${f.h * 100}%`;
    node.innerHTML = previewHtml(f, mine);

    if (fillable) node.addEventListener('click', () => fill(f));
    holder.appendChild(node);
  }
  updateProgress();
}

function previewHtml(f, mine) {
  const spec = S.fieldTypes[f.type];
  const v = values[f.id];

  if (spec.render === 'image') {
    if (v) return `<img src="${v}" alt="">`;
    return `<span class="txt">${mine ? spec.label : ''}</span>`;
  }
  if (f.type === 'checkbox') {
    return `<span class="txt" style="font-size:${Math.max(11, f.h * 400)}px">${v ? '✕' : ''}</span>`;
  }
  // Auto-filled types show what will be stamped, so the signer can see it is right.
  if (spec.fill === 'auto' && mine) {
    const auto = {
      date_signed: new Date().toISOString().slice(0, 10),
      name: S.recipientName,
      email: S.recipientEmail,
    }[f.type];
    return `<span class="txt">${escapeHtml(auto ?? spec.label)}</span>`;
  }
  return `<span class="txt">${escapeHtml(v || (mine ? spec.label : ''))}</span>`;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* -------------------------------------------------------------- filling in */

async function fill(f) {
  switch (f.type) {
    case 'signature':
    case 'initials': {
      const data = await openSignaturePad({
        name: S.recipientName,
        initialsOnly: f.type === 'initials',
      });
      if (data) values[f.id] = data;
      break;
    }
    case 'drawing': {
      const data = await openDrawingPad();
      if (data) values[f.id] = data;
      break;
    }
    case 'image': {
      const picked = await pickFile('image/*');
      if (picked) values[f.id] = picked.dataUrl;
      break;
    }
    case 'attachment': {
      const picked = await pickFile('application/pdf,image/*');
      if (picked) {
        values[f.id] = picked.name;
        files[f.id] = picked;
      }
      break;
    }
    case 'checkbox':
      values[f.id] = !values[f.id];
      break;
    case 'dropdown':
    case 'radio': {
      const chosen = await pickOption(f);
      if (chosen != null) values[f.id] = chosen;
      break;
    }
    case 'editable_date': {
      const iso = await promptFor(f, 'date', values[f.id] || '');
      if (iso != null) {
        values[f.id] = f.meta?.format === 'DD/MM/YYYY' && iso
          ? iso.split('-').reverse().join('/')
          : iso;
      }
      break;
    }
    default: {
      const text = await promptFor(f, 'text', values[f.id] || '');
      if (text != null) values[f.id] = text;
    }
  }
  drawFields();
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > 8 * 1024 * 1024) {
        alert('Please choose a file smaller than 8 MB.');
        return resolve(null);
      }
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, mime: file.type, dataUrl: reader.result });
      reader.readAsDataURL(file);
    });
    input.click();
  });
}

/* ------------------------------------------------------------ small modals */

function modal(innerHtml, wire) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${innerHtml}</div>`;
    document.body.appendChild(back);

    const close = (result) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });

    wire(back.querySelector('.modal'), close);
  });
}

function promptFor(f, inputType, current) {
  const spec = S.fieldTypes[f.type];
  const multiline = f.type === 'textbox' && f.meta?.multiline;
  const control = multiline
    ? `<textarea id="m-input" rows="4">${escapeHtml(current)}</textarea>`
    : `<input id="m-input" type="${inputType}" value="${escapeHtml(current)}" placeholder="${escapeHtml(f.meta?.placeholder || '')}">`;

  return modal(
    `<h2>${spec.label}</h2>
     <p class="sub">${f.required ? 'Required.' : 'Optional.'}</p>
     <div class="field">${control}</div>
     <div class="btn-row"><button class="btn" id="m-ok">Apply</button>
     <button class="btn btn-ghost" id="m-cancel">Cancel</button></div>`,
    (m, close) => {
      const input = m.querySelector('#m-input');
      input.focus();
      input.select?.();
      m.querySelector('#m-ok').addEventListener('click', () => close(input.value));
      m.querySelector('#m-cancel').addEventListener('click', () => close(null));
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) close(input.value); });
    }
  );
}

function pickOption(f) {
  const options = f.meta?.options?.length ? f.meta.options : ['Yes', 'No'];
  return modal(
    `<h2>${S.fieldTypes[f.type].label}</h2>
     <p class="sub">Choose one.</p>
     ${options.map((o, i) => `<label class="check" style="padding:7px 0">
        <input type="radio" name="opt" value="${escapeHtml(o)}" ${i === 0 ? 'checked' : ''}>
        <span>${escapeHtml(o)}</span></label>`).join('')}
     <div class="btn-row" style="margin-top:14px"><button class="btn" id="m-ok">Apply</button>
     <button class="btn btn-ghost" id="m-cancel">Cancel</button></div>`,
    (m, close) => {
      m.querySelector('#m-ok').addEventListener('click', () =>
        close(m.querySelector('input[name=opt]:checked')?.value ?? null));
      m.querySelector('#m-cancel').addEventListener('click', () => close(null));
    }
  );
}

/* -------------------------------------------------------------- progress */

const isFilled = (f) => {
  const v = values[f.id];
  return f.type === 'checkbox' ? v === true : v != null && v !== '';
};

// Fields in reading order — page, then down the page, then across.
const inOrder = () => [...myFields].sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);

function updateProgress() {
  const done = myFields.filter(isFilled).length;
  el.doneCount.textContent = String(done);
  const allRequired = myFields.every((f) => !f.required || isFilled(f));
  el.finish.disabled = !(allRequired && consented);
  // Once nothing required is left, Next field has done its job and Finish is
  // the thing to press — it says so by taking the emphasis.
  el.finish.classList.toggle('pulse-btn', allRequired && consented);
  el.next.textContent = allRequired ? 'Review fields' : 'Next field';
  markThumbs();
}

/** Scrolls to the next field still to fill (required first) and highlights it. */
el.next.addEventListener('click', () => {
  const order = inOrder();
  const target =
    order.find((f) => f.required && !isFilled(f)) ||
    order.find((f) => !isFilled(f)) ||
    order[0];
  if (!target) return;
  const node = document.querySelector(`.sfld[data-id="${target.id}"]`);
  if (!node) return;
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('pulse');
  void node.offsetWidth;
  node.classList.add('pulse');
});

/* --------------------------------------------------------------- welcome */

el.consent.addEventListener('change', () => { el.welcomeContinue.disabled = !el.consent.checked; });
el.welcomeContinue.addEventListener('click', () => {
  if (!el.consent.checked) return;
  consented = true;
  el.welcome.remove();
  updateProgress();
  // Straight to the first thing to fill, so the signer is never left looking
  // for where to start.
  if (myFields.length) setTimeout(() => el.next.click(), 150);
});

/* ---------------------------------------------------------------- submit */

/** The last chance to look again: what is about to be signed, and as whom. */
function confirmSigning() {
  const done = myFields.filter(isFilled).length;
  return modal(
    `<h2>Sign “${escapeHtml(S.title)}”?</h2>
     <p class="sub">You are signing as <strong>${escapeHtml(S.recipientName)}</strong> (${escapeHtml(S.recipientEmail)}),
       with ${done} of ${myFields.length} field${myFields.length === 1 ? '' : 's'} completed.
       Once signed, it cannot be changed or withdrawn.</p>
     <div class="btn-row"><button class="btn" id="m-ok">Sign</button>
     <button class="btn btn-ghost" id="m-cancel">Go back</button></div>`,
    (m, close) => {
      m.querySelector('#m-ok').addEventListener('click', () => close(true));
      m.querySelector('#m-cancel').addEventListener('click', () => close(null));
      m.querySelector('#m-ok').focus();
    }
  );
}

el.finish.addEventListener('click', async () => {
  if (!(await confirmSigning())) return;
  el.finish.disabled = true;
  el.finish.textContent = 'Sealing…';
  el.error.hidden = true;

  try {
    const res = await fetch(`/sign/${S.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: consented, values, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Could not save (HTTP ${res.status}).`);
    window.location = data.redirect;
  } catch (err) {
    el.error.textContent = err.message;
    el.error.hidden = false;
    el.finish.disabled = false;
    el.finish.textContent = 'Finish';
  }
});

async function decline() {
  const reason = await modal(
    `<h2>Decline to sign</h2>
     <p class="sub">The sender will be told. You will not be able to sign this document afterwards.</p>
     <div class="field"><label>Reason (optional)</label><textarea id="m-input" rows="3"></textarea></div>
     <div class="btn-row"><button class="btn btn-danger" id="m-ok">Decline</button>
     <button class="btn btn-ghost" id="m-cancel">Go back</button></div>`,
    (m, close) => {
      m.querySelector('#m-ok').addEventListener('click', () => close(m.querySelector('#m-input').value));
      m.querySelector('#m-cancel').addEventListener('click', () => close(null));
    }
  );
  if (reason == null) return;
  document.getElementById('decline-reason').value = reason;
  document.getElementById('decline-form').submit();
}
document.getElementById('decline-btn').addEventListener('click', decline);
document.getElementById('welcome-decline').addEventListener('click', decline);

render();
window.addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(render, 250); });
