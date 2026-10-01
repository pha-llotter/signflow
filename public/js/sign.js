/**
 * The signing page.
 *
 * Renders the document as the author laid it out, overlays only the fields
 * addressed to this signer as fillable, and collects their answers. Nothing is
 * committed until the signer ticks consent and presses Finish — the server
 * re-checks both, so this is convenience, not the control.
 */
import * as pdfjsLib from '/static/vendor/pdfjs/pdf.min.mjs';
import { openSignaturePad, openDrawingPad } from '/static/js/signature-pad.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';

const S = window.__SIGN__;
const BASE_WIDTH = 860;

const values = {};   // field id -> value going to the server
const files = {};    // field id -> { name, mime, dataUrl } for attachment fields
let pageEls = [];

const el = {
  pages: document.getElementById('pages'),
  todo: document.getElementById('todo-list'),
  doneCount: document.getElementById('done-count'),
  consent: document.getElementById('consent'),
  finish: document.getElementById('finish-btn'),
  error: document.getElementById('sign-error'),
  side: document.getElementById('sign-side'),
  sheetToggle: document.getElementById('sheet-toggle'),
  sheetProgress: document.getElementById('sheet-progress'),
};

const myFields = S.fields.filter(
  (f) => f.recipient_id === S.recipientId && S.fieldTypes[f.type].fill === 'signer'
);

/* ------------------------------------------------------------------ render */

async function render() {
  const pdf = await pdfjsLib.getDocument({ url: S.pdfUrl, withCredentials: true }).promise;
  el.pages.innerHTML = '';
  pageEls = [];

  // Measure the container's real content box rather than assuming the padding,
  // which differs between the desktop and phone layouts.
  const holderEl = el.pages.parentElement;
  const cs = getComputedStyle(holderEl);
  const inner = holderEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
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

function updateProgress() {
  let done = 0;
  for (const f of myFields) {
    const v = values[f.id];
    const filled = f.type === 'checkbox' ? v === true : v != null && v !== '';
    if (filled) done++;
    const li = el.todo.querySelector(`li[data-id="${f.id}"]`);
    if (li) li.classList.toggle('done', filled);
  }
  el.doneCount.textContent = String(done);
  el.sheetProgress.textContent = `${done} of ${myFields.length}`;

  const allRequired = myFields.every((f) => {
    if (!f.required) return true;
    const v = values[f.id];
    return f.type === 'checkbox' ? v === true : v != null && v !== '';
  });
  el.finish.disabled = !(allRequired && el.consent.checked);

  // Once there is nothing left to fill, bring the sheet up on its own — the
  // consent box and Finish button live inside it, so leaving it shut would
  // look like a dead end.
  if (allRequired && !sheetOpen() && isSheetLayout()) openSheet();
}

el.consent.addEventListener('change', updateProgress);

/* ------------------------------------------------ the mobile bottom sheet */

// The sheet only exists below the layout breakpoint; above it the panel is
// always visible and the handle is hidden, so these become no-ops.
const isSheetLayout = () => getComputedStyle(el.sheetToggle).display !== 'none';
const sheetOpen = () => el.side.classList.contains('open');

let scrim = null;

function openSheet() {
  el.side.classList.add('open');
  el.sheetToggle.setAttribute('aria-expanded', 'true');
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.className = 'sheet-scrim';
    scrim.addEventListener('click', closeSheet);
    document.body.appendChild(scrim);
  }
}

function closeSheet() {
  el.side.classList.remove('open');
  el.sheetToggle.setAttribute('aria-expanded', 'false');
  scrim?.remove();
  scrim = null;
}

el.sheetToggle.addEventListener('click', () => (sheetOpen() ? closeSheet() : openSheet()));

// Returning to a wide window must not leave an orphaned scrim over the page.
window.addEventListener('resize', () => { if (!isSheetLayout()) closeSheet(); });

el.todo.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const node = document.querySelector(`.sfld[data-id="${li.dataset.id}"]`);
  if (!node) return;
  // Get the sheet out of the way, or it covers the field being jumped to.
  closeSheet();
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  node.classList.remove('pulse');
  void node.offsetWidth;
  node.classList.add('pulse');
});

/* ---------------------------------------------------------------- submit */

el.finish.addEventListener('click', async () => {
  el.finish.disabled = true;
  el.finish.textContent = 'Sealing…';
  el.error.style.display = 'none';

  try {
    const res = await fetch(`/sign/${S.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, values, files }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Could not save (HTTP ${res.status}).`);
    window.location = data.redirect;
  } catch (err) {
    el.error.textContent = err.message;
    el.error.style.display = 'block';
    el.finish.disabled = false;
    el.finish.textContent = 'Finish signing';
  }
});

document.getElementById('decline-btn').addEventListener('click', async () => {
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
});

render();
window.addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(render, 250); });
