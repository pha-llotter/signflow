/**
 * The field placer.
 *
 * Coordinates are stored as fractions of the page box (x/y/w/h in 0..1, y from
 * the page top) rather than pixels. That is what lets the same layout survive a
 * zoom change, a different screen, and the jump from a rendered canvas to PDF
 * points at sealing time — the server never has to know what scale the author
 * happened to be looking at.
 */
import * as pdfjsLib from '/static/vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/vendor/pdfjs/pdf.worker.min.mjs';

const DOC = window.__DOC__;
const RECIPIENT_COLORS = ['#2b5bd7', '#b8410e', '#17734a', '#6d3fb8', '#a8850c', '#0f6f86'];
const MAX_WIDTH = 820;           // CSS px for a page at 100% on a wide screen
const MIN_WIDTH = 280;
const GRID_PX = 20;

const state = {
  fields: DOC.fields.map(normalise),
  activeRecipient: DOC.recipients[0]?.id || null,
  selectedId: null,
  zoom: 1,
  snap: true,
  dirty: false,
  armedType: null,
};

const el = {
  pages: document.getElementById('pages'),
  area: document.getElementById('canvas-area'),
  inspector: document.getElementById('inspector-body'),
  noSelection: document.getElementById('no-selection'),
  saveState: document.getElementById('save-state'),
  zoomLabel: document.getElementById('zoom-label'),
};

function normalise(f) {
  return {
    id: f.id,
    type: f.type,
    recipient_id: f.recipient_id,
    page: f.page,
    x: f.x, y: f.y, w: f.w, h: f.h,
    required: f.required !== 0 && f.required !== false,
    font_size: f.font_size || 11,
    align: f.align || 'left',
    color: f.color || '#111111',
    meta: f.meta || {},
  };
}

const colorFor = (recipientId) => {
  const i = DOC.recipients.findIndex((r) => r.id === recipientId);
  return i < 0 ? '#5a6472' : RECIPIENT_COLORS[i % RECIPIENT_COLORS.length];
};

document.querySelectorAll('[data-swatch]').forEach((s) => {
  s.style.background = colorFor(s.dataset.swatch);
});

/* ------------------------------------------------------------------ render */

let pageEls = [];

/**
 * Page width at 100% zoom: the column it has to live in, capped so it does not
 * become gigantic on a wide monitor.
 *
 * A fixed width is what made this unusable on a phone — an 820px page inside a
 * 390px column means you are looking at half a document through a letterbox and
 * tapping where you cannot see. Zooming past 100% still overflows and scrolls,
 * which is the point of zooming.
 */
function fitWidth() {
  const cs = getComputedStyle(el.area);
  const inner = el.area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return Math.max(MIN_WIDTH, Math.min(inner, MAX_WIDTH));
}

async function renderPdf() {
  const pdf = await pdfjsLib.getDocument({ url: DOC.pdfUrl, withCredentials: true }).promise;
  el.pages.innerHTML = '';
  pageEls = [];

  const base = fitWidth();

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    // rotation defaults to the page's own /Rotate, which is what the server
    // compensates for when stamping — keep them in step.
    const natural = page.getViewport({ scale: 1 });
    const scale = (base * state.zoom) / natural.width;
    const viewport = page.getViewport({ scale });

    const holder = document.createElement('div');
    holder.className = 'pdf-page';
    holder.dataset.page = String(i);
    holder.style.width = `${viewport.width}px`;
    holder.style.height = `${viewport.height}px`;

    const canvas = document.createElement('canvas');
    // Render at device pixel ratio so text stays crisp, but lay out at CSS size.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const badge = document.createElement('div');
    badge.className = 'page-num';
    badge.textContent = `Page ${i + 1}`;

    holder.append(canvas, badge);
    el.pages.appendChild(holder);
    pageEls.push(holder);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    await page.render({ canvasContext: ctx, viewport }).promise;
  }

  drawFields();
}

function drawFields() {
  pageEls.forEach((p) => p.querySelectorAll('.fld').forEach((n) => n.remove()));

  for (const f of state.fields) {
    const holder = pageEls[f.page];
    if (!holder) continue;

    const node = document.createElement('div');
    node.className = 'fld' + (f.id === state.selectedId ? ' selected' : '');
    node.dataset.id = f.id;
    node.style.left = `${f.x * 100}%`;
    node.style.top = `${f.y * 100}%`;
    node.style.width = `${f.w * 100}%`;
    node.style.height = `${f.h * 100}%`;
    node.style.setProperty('--recip-color', colorFor(f.recipient_id));

    const label = document.createElement('span');
    label.className = 'lbl';
    label.textContent = labelFor(f);
    node.appendChild(label);

    const handle = document.createElement('div');
    handle.className = 'handle';
    node.appendChild(handle);

    const del = document.createElement('button');
    del.className = 'del';
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove this field';
    node.appendChild(del);

    holder.appendChild(node);
  }
  renderGuidance();
}

function labelFor(f) {
  const spec = DOC.fieldTypes[f.type];
  if (f.type === 'label') return f.meta.text || 'Label';
  if (f.type === 'stamp') return f.meta.text || 'APPROVED';
  if (f.type === 'hyperlink') return f.meta.text || 'Link';
  const owner = DOC.recipients.find((r) => r.id === f.recipient_id);
  const initials = owner ? ` · ${owner.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}` : '';
  return `${spec.label}${initials}`;
}

/* -------------------------------------------------------------- recipients */

document.getElementById('recip-list').addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  state.activeRecipient = li.dataset.id;
  document.querySelectorAll('#recip-list li').forEach((n) => n.classList.toggle('active', n === li));
});

/* -------------------------------------------------------- drag from palette */

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', chip.dataset.type);
    e.dataTransfer.effectAllowed = 'copy';
    // In a narrower window the palette is a drawer over a scrim, and the scrim
    // would take the drop instead of the page — the field silently goes
    // nowhere. Once a drag is under way the drawer has done its job, so it gets
    // out of the way. Deferred a tick: Chrome cancels a drag whose source moves
    // during dragstart itself.
    if (palette.classList.contains('open')) setTimeout(closeDrawers, 0);
  });
});

el.pages.addEventListener('dragover', (e) => {
  if (e.target.closest('.pdf-page')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
});

el.pages.addEventListener('drop', (e) => {
  const holder = e.target.closest('.pdf-page');
  if (!holder) return;
  e.preventDefault();
  placeField(e.dataTransfer.getData('text/plain'), holder, e.clientX, e.clientY);
});

/**
 * A version-4 UUID for a new field. crypto.randomUUID() exists only in a
 * secure context — HTTPS or localhost — so on a plain-http LAN address such as
 * http://172.16.0.22 it is undefined, and calling it threw inside the drop
 * handler: every field dropped vanished without a word. getRandomValues has no
 * such restriction and gives the same format the server checks for.
 */
function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Creates a field centred on a point, in page-relative fractions. */
function placeField(type, holder, clientX, clientY) {
  const spec = DOC.fieldTypes[type];
  if (!spec) return false;

  if (spec.fill !== 'author' && !state.activeRecipient) {
    alert('Add a recipient before placing a field they have to fill in.');
    return false;
  }

  const rect = holder.getBoundingClientRect();
  // The drop point becomes the field's centre — it is where the pointer is, so
  // it is where the author expects the field to land.
  let px = clientX - rect.left - (spec.w * rect.width) / 2;
  let py = clientY - rect.top - (spec.h * rect.height) / 2;
  ({ px, py } = snapPx(px, py));

  const field = normalise({
    id: newId(),
    type,
    recipient_id: spec.fill === 'author' ? null : state.activeRecipient,
    page: Number(holder.dataset.page),
    x: clamp(px / rect.width, 0, 1 - spec.w),
    y: clamp(py / rect.height, 0, 1 - spec.h),
    w: spec.w,
    h: spec.h,
    required: 1,
    meta: defaultMeta(type),
  });

  state.fields.push(field);
  select(field.id);
  markDirty();
  drawFields();
  return true;
}

/* ---------------------------------------------------- tap to place (touch) */

// HTML5 drag-and-drop does not fire on touch at all, so on a phone or tablet
// the palette would be inert. Tapping a chip arms it instead; the next tap on
// the page drops the field there.
function armType(type) {
  state.armedType = type;
  document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('armed', c.dataset.type === type));
  // Disarming hands the status line back rather than asserting a value —
  // placing a field disarms immediately after marking the document dirty, so a
  // hardcoded "All changes saved" here would be a lie.
  if (!type) renderSaveState();
  renderGuidance();
}

/**
 * Tells the author what to do next, over the document rather than in the
 * toolbar — on a phone the toolbar is a strip of small grey text above the
 * thing they are actually looking at, and it goes unread.
 */
function renderGuidance() {
  const banner = document.getElementById('placer-banner');
  const empty = document.getElementById('placer-empty');

  if (state.armedType) {
    document.getElementById('banner-text').textContent =
      `Tap the page where the ${DOC.fieldTypes[state.armedType].label.toLowerCase()} should go`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  empty.hidden = state.fields.length > 0 || !!state.armedType;
}

document.getElementById('banner-cancel').addEventListener('click', () => armType(null));

// Touch-only means no mouse or trackpad at all. "(pointer: coarse)" alone is
// not that: it describes the *primary* pointer, and Chrome on a touchscreen
// Windows laptop can report touch as primary while the person is holding a
// mouse — which switched drag-and-drop off for them entirely.
const TOUCH_ONLY = !!window.matchMedia && !window.matchMedia('(any-pointer: fine)').matches;

document.querySelectorAll('.chip').forEach((chip) => {
  // HTML5 drag-and-drop does not exist on touch, and leaving the attribute on
  // only gives the browser an excuse to treat a press as the start of a native
  // drag instead of a tap. Click-to-place below works everywhere regardless.
  if (TOUCH_ONLY) chip.removeAttribute('draggable');

  chip.addEventListener('click', () => {
    armType(state.armedType === chip.dataset.type ? null : chip.dataset.type);
    closeDrawers();
  });
});

function defaultMeta(type) {
  switch (type) {
    case 'signature': return { certified: true };
    case 'label': return { text: 'Label' };
    case 'hyperlink': return { text: 'Link', url: '' };
    case 'stamp': return { text: 'APPROVED', dated: true };
    case 'qrcode': return { data: '' };
    case 'dropdown':
    case 'radio': return { options: ['Option one', 'Option two'] };
    case 'editable_date': return { format: 'YYYY-MM-DD' };
    case 'textbox': return { placeholder: '', multiline: false };
    default: return {};
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function snapPx(px, py) {
  if (!state.snap) return { px, py };
  return { px: Math.round(px / GRID_PX) * GRID_PX, py: Math.round(py / GRID_PX) * GRID_PX };
}

/* ------------------------------------------------- move, resize and delete */

let drag = null;

/**
 * Placement happens on `click`, not on any pointer event.
 *
 * A touch that becomes a scroll and a touch that is a tap begin with an
 * identical pointerdown, so placing there drops a field at the start of every
 * swipe. Deciding on pointerup by measuring finger travel is no better: inside
 * a scrollable container mobile browsers routinely fire `pointercancel`
 * instead of `pointerup`, so the tap is simply lost and nothing happens.
 *
 * `click` is the event the platform already emits for "this was a tap, not a
 * scroll or a drag" — on every browser, with the right thresholds for that
 * device. Reimplementing that heuristic by hand was the mistake.
 */
el.pages.addEventListener('click', (e) => {
  if (!state.armedType) return;

  // The finger may lift over a field or the page-number badge; the page
  // underneath is what matters.
  const holder = e.target.closest('.pdf-page');
  if (!holder) return;

  placeField(state.armedType, holder, e.clientX, e.clientY);
  armType(null);
});

el.pages.addEventListener('pointerdown', (e) => {
  // Armed: leave the gesture entirely alone. No preventDefault, no capture —
  // the page must stay scrollable while the author looks for the right spot,
  // and the browser must stay free to decide whether this becomes a click.
  if (state.armedType) return;

  const node = e.target.closest('.fld');
  if (!node) { select(null); return; }

  if (e.target.classList.contains('del')) {
    state.fields = state.fields.filter((f) => f.id !== node.dataset.id);
    select(null);
    markDirty();
    drawFields();
    return;
  }

  const field = state.fields.find((f) => f.id === node.dataset.id);
  if (!field) return;
  select(field.id);

  const holder = node.closest('.pdf-page');
  const rect = holder.getBoundingClientRect();
  drag = {
    field,
    node,
    rect,
    mode: e.target.classList.contains('handle') ? 'resize' : 'move',
    startX: e.clientX,
    startY: e.clientY,
    origin: { x: field.x, y: field.y, w: field.w, h: field.h },
  };
  node.setPointerCapture(e.pointerId);
  e.preventDefault();
});

el.pages.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / drag.rect.width;
  const dy = (e.clientY - drag.startY) / drag.rect.height;
  const f = drag.field;
  drag.moved = true;

  if (drag.mode === 'move') {
    let px = (drag.origin.x + dx) * drag.rect.width;
    let py = (drag.origin.y + dy) * drag.rect.height;
    ({ px, py } = snapPx(px, py));
    f.x = clamp(px / drag.rect.width, 0, 1 - f.w);
    f.y = clamp(py / drag.rect.height, 0, 1 - f.h);
    drag.node.style.left = `${f.x * 100}%`;
    drag.node.style.top = `${f.y * 100}%`;
  } else {
    // A field smaller than a few pixels is impossible to grab again.
    f.w = clamp(drag.origin.w + dx, 0.012, 1 - f.x);
    f.h = clamp(drag.origin.h + dy, 0.008, 1 - f.y);
    drag.node.style.width = `${f.w * 100}%`;
    drag.node.style.height = `${f.h * 100}%`;
  }
});

const endDrag = () => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  // Merely selecting a field should not mark the document unsaved.
  if (moved) markDirty();
};

// A swipe produces no click, so the chip stays armed and the author can scroll
// to the right place and then tap — rather than re-arming after every scroll.
el.pages.addEventListener('pointerup', endDrag);
el.pages.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (e) => {
  if (!state.selectedId) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (typing) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    state.fields = state.fields.filter((f) => f.id !== state.selectedId);
    select(null);
    markDirty();
    drawFields();
    e.preventDefault();
    return;
  }

  const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (nudge) {
    const f = state.fields.find((x) => x.id === state.selectedId);
    // Measure the page actually on screen, so one press moves one pixel at any
    // zoom or window size rather than a different distance each time.
    const rect = pageEls[f.page]?.getBoundingClientRect();
    if (!rect) return;
    const px = e.shiftKey ? GRID_PX : 1;
    f.x = clamp(f.x + (nudge[0] * px) / rect.width, 0, 1 - f.w);
    f.y = clamp(f.y + (nudge[1] * px) / rect.height, 0, 1 - f.h);
    markDirty();
    drawFields();
    e.preventDefault();
  }
});

/* --------------------------------------------------------------- inspector */

function select(id) {
  state.selectedId = id;
  document.querySelectorAll('.fld').forEach((n) => n.classList.toggle('selected', n.dataset.id === id));
  renderInspector();
}

function renderInspector() {
  const f = state.fields.find((x) => x.id === state.selectedId);
  el.noSelection.hidden = !!f;
  el.inspector.hidden = !f;
  if (!f) return;

  const spec = DOC.fieldTypes[f.type];
  const rows = [];

  rows.push(`<p style="margin:0 0 14px;font-weight:600">${spec.label}
    <span class="hint" style="display:block;font-weight:400;margin-top:2px">Page ${f.page + 1} ·
    ${spec.fill === 'signer' ? 'the signer fills this in' : spec.fill === 'auto' ? 'filled in automatically' : 'fixed by you'}</span></p>`);

  if (spec.fill !== 'author') {
    rows.push(`<div class="field"><label>Assigned to</label><select data-bind="recipient_id">
      ${DOC.recipients.map((r) => `<option value="${r.id}" ${r.id === f.recipient_id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
    </select></div>`);
  }

  if (spec.fill === 'signer') {
    rows.push(`<label class="check" style="margin-bottom:12px"><input type="checkbox" data-bind="required" ${f.required ? 'checked' : ''}>
      <span>Required — they cannot finish without it</span></label>`);
  }

  switch (f.type) {
    case 'signature':
      rows.push(`<label class="check" style="margin-bottom:8px"><input type="checkbox" data-bind="meta.certified" ${f.meta.certified !== false ? 'checked' : ''}>
        <span>Certify the signature — prints the signer's name, email, the time they signed and the
        document reference around the mark</span></label>`);
      rows.push(`<p class="hint" style="margin:-2px 0 12px">Turn this off for a bare signature. A tall field
        stacks the details under the mark; a short one sets them beside it. Only a field too small to print
        them legibly falls back to the mark alone.</p>`);
      break;
    case 'label':
      rows.push(textRow('Text on the page', 'meta.text', f.meta.text || ''));
      break;
    case 'hyperlink':
      rows.push(textRow('Link text', 'meta.text', f.meta.text || ''));
      rows.push(textRow('URL (https only)', 'meta.url', f.meta.url || '', 'url'));
      break;
    case 'qrcode':
      rows.push(textRow('Encodes', 'meta.data', f.meta.data || ''));
      rows.push(`<p class="hint" style="margin-top:-6px">Leave blank to encode this document's verification page.</p>`);
      break;
    case 'stamp':
      rows.push(`<div class="field"><label>Wording</label>
        <input type="text" data-bind="meta.text" value="${escapeHtml(f.meta.text || '')}" list="stamp-presets">
        <datalist id="stamp-presets">${DOC.stampPresets.map((p) => `<option value="${p}">`).join('')}</datalist></div>`);
      rows.push(`<label class="check" style="margin-bottom:12px"><input type="checkbox" data-bind="meta.dated" ${f.meta.dated !== false ? 'checked' : ''}>
        <span>Print today's date under it</span></label>`);
      break;
    case 'dropdown':
    case 'radio':
      rows.push(`<div class="field"><label>Options, one per line</label>
        <textarea data-bind="meta.options">${escapeHtml((f.meta.options || []).join('\n'))}</textarea></div>`);
      break;
    case 'textbox':
      rows.push(textRow('Placeholder', 'meta.placeholder', f.meta.placeholder || ''));
      rows.push(`<label class="check" style="margin-bottom:12px"><input type="checkbox" data-bind="meta.multiline" ${f.meta.multiline ? 'checked' : ''}>
        <span>Allow more than one line</span></label>`);
      break;
    case 'editable_date':
      rows.push(`<div class="field"><label>Format</label><select data-bind="meta.format">
        <option value="YYYY-MM-DD" ${f.meta.format !== 'DD/MM/YYYY' ? 'selected' : ''}>YYYY-MM-DD</option>
        <option value="DD/MM/YYYY" ${f.meta.format === 'DD/MM/YYYY' ? 'selected' : ''}>DD/MM/YYYY</option>
      </select></div>`);
      break;
  }

  if (['text', 'link', 'none'].includes(spec.render) || spec.render === 'check') {
    rows.push(`<div class="field"><label>Text size</label>
      <input type="number" data-bind="font_size" value="${f.font_size}" min="5" max="48" step="0.5"></div>`);
    rows.push(`<div class="field"><label>Alignment</label><select data-bind="align">
      ${['left', 'center', 'right'].map((a) => `<option value="${a}" ${f.align === a ? 'selected' : ''}>${a}</option>`).join('')}
    </select></div>`);
    rows.push(`<div class="field"><label>Colour</label>
      <input type="color" data-bind="color" value="${f.color}" style="height:34px;padding:2px"></div>`);
  }

  rows.push(`<button class="btn btn-danger btn-sm" type="button" id="remove-field" style="width:100%;margin-top:8px">Remove field</button>`);

  el.inspector.innerHTML = rows.join('');

  el.inspector.querySelectorAll('[data-bind]').forEach((input) => {
    input.addEventListener('input', () => {
      applyBinding(f, input.dataset.bind, input);
      markDirty();
      drawFields();
      // drawFields rebuilds the nodes, so restore the selection ring.
      document.querySelectorAll('.fld').forEach((n) => n.classList.toggle('selected', n.dataset.id === f.id));
    });
  });

  document.getElementById('remove-field').addEventListener('click', () => {
    state.fields = state.fields.filter((x) => x.id !== f.id);
    select(null);
    markDirty();
    drawFields();
  });
}

function applyBinding(field, path, input) {
  let value;
  if (input.type === 'checkbox') value = input.checked;
  else if (input.type === 'number') value = Number(input.value);
  else if (path === 'meta.options') value = input.value.split('\n').map((s) => s.trim()).filter(Boolean);
  else value = input.value;

  if (path.startsWith('meta.')) field.meta[path.slice(5)] = value;
  else field[path] = value;
}

function textRow(label, bind, value, type = 'text') {
  return `<div class="field"><label>${label}</label>
    <input type="${type}" data-bind="${bind}" value="${escapeHtml(value)}"></div>`;
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ------------------------------------------------------- zoom, grid, saving */

function setZoom(z) {
  state.zoom = clamp(z, 0.5, 2.5);
  el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  renderPdf();
}
document.getElementById('zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.15));
document.getElementById('zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.15));

document.getElementById('grid-toggle').addEventListener('change', (e) => {
  state.snap = e.target.checked;
  el.area.classList.toggle('grid-on', state.snap);
});

/* ------------------------------------------------------ drawers on narrow screens */

// Below the editor's breakpoint the palette and inspector slide in over the
// page. Above it they are static columns and these toggles are hidden, so the
// class is harmless either way.
const palette = document.querySelector('.palette');
const inspectorEl = document.getElementById('inspector');
let drawerScrim = null;

function closeDrawers() {
  palette.classList.remove('open');
  inspectorEl.classList.remove('open');
  drawerScrim?.remove();
  drawerScrim = null;
}

function toggleDrawer(node) {
  const wasOpen = node.classList.contains('open');
  closeDrawers();
  if (wasOpen) return;
  node.classList.add('open');
  drawerScrim = document.createElement('div');
  drawerScrim.className = 'drawer-scrim';
  drawerScrim.addEventListener('click', closeDrawers);
  document.body.appendChild(drawerScrim);
}

document.getElementById('toggle-palette').addEventListener('click', () => toggleDrawer(palette));
document.getElementById('toggle-inspector').addEventListener('click', () => toggleDrawer(inspectorEl));

// Dropping a field or picking a recipient means the drawer has done its job.
palette.addEventListener('click', (e) => {
  if (e.target.closest('.recip-list li')) closeDrawers();
});
window.addEventListener('resize', () => {
  if (getComputedStyle(document.getElementById('toggle-palette')).display === 'none') closeDrawers();
});

let saveTimer = null;

/** Single source of truth for the status line, so nothing has to guess at it. */
function renderSaveState(override) {
  el.saveState.textContent = override ?? (state.dirty ? 'Unsaved changes' : 'All changes saved');
}

function markDirty() {
  state.dirty = true;
  if (!state.armedType) renderSaveState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

async function save() {
  clearTimeout(saveTimer);
  renderSaveState('Saving…');
  try {
    const res = await fetch(`/api/documents/${DOC.id}/fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: state.fields }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    // Only the server's own confirmation counts. A redirect that fetch
    // followed to some HTML page is a 200 too, and used to read as saved.
    if (res.redirected || !body?.ok) throw new Error('the server did not confirm the save. Reload the page.');
    state.dirty = false;
    renderSaveState();
  } catch (err) {
    renderSaveState(`Not saved — ${err.message}`);
  }
}

document.getElementById('save-btn').addEventListener('click', save);

// Sending reads fields from the database, so flush anything pending first.
document.getElementById('send-form').addEventListener('submit', async (e) => {
  if (!state.fields.length) {
    e.preventDefault();
    alert(e.target.dataset.emptyMessage || 'Place at least one field before sending.');
    return;
  }
  if (state.dirty) {
    e.preventDefault();
    await save();
    if (!state.dirty) e.target.submit();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Rotating a phone changes the column width, and the page has to be re-fitted
// to it. Field positions are fractions of the page, so nothing moves.
let refitTimer = null;
let lastFit = 0;
window.addEventListener('resize', () => {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    const next = fitWidth();
    if (Math.abs(next - lastFit) < 2) return;
    lastFit = next;
    renderPdf();
  }, 200);
});

lastFit = fitWidth();
renderPdf();

/* ------------------------------------------------------------ diagnostics */

// ?debug on the placer's address shows what this browser reports and logs each
// drag event as it happens, so a "dragging does nothing" report can be read
// off the screen instead of guessed at. Nothing is sent anywhere.
if (new URLSearchParams(location.search).has('debug')) {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;max-width:min(560px,94vw);max-height:42vh;overflow:auto;' +
    'margin:0;padding:10px 12px;background:#0e1420;color:#e8ebf1;font:12px/1.45 ui-monospace,Consolas,monospace;' +
    'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:pre-wrap;pointer-events:none';
  const mq = (q) => (window.matchMedia ? window.matchMedia(q).matches : 'n/a');
  const lines = [
    `window ${innerWidth}×${innerHeight} · zoom/dpr ${devicePixelRatio}`,
    `pointer:coarse ${mq('(pointer: coarse)')} · any-pointer:fine ${mq('(any-pointer: fine)')} · touch points ${navigator.maxTouchPoints}`,
    `touch-only mode ${TOUCH_ONLY} · chips draggable ${document.querySelector('.chip')?.getAttribute('draggable')}`,
    `palette as drawer ${getComputedStyle(document.getElementById('toggle-palette')).display !== 'none'}`,
    `${navigator.userAgent}`,
    '— events —',
  ];
  const render = () => { box.textContent = lines.slice(-40).join('\n'); };
  const log = (msg) => { lines.push(`${(performance.now() / 1000).toFixed(2)}s ${msg}`); render(); };
  const where = (e) => {
    const t = e.target;
    return `${t.tagName?.toLowerCase()}${t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : ''}`;
  };
  let overs = 0;
  document.addEventListener('dragstart', (e) => log(`dragstart on ${where(e)}`), true);
  document.addEventListener('dragenter', (e) => log(`dragenter ${where(e)}`), true);
  document.addEventListener('dragover', (e) => { if (overs++ % 25 === 0) log(`dragover ${where(e)} (accepted: ${e.defaultPrevented})`); }, true);
  document.addEventListener('drop', (e) => log(`drop on ${where(e)}`), true);
  document.addEventListener('dragend', (e) => log(`dragend · dropEffect ${e.dataTransfer?.dropEffect}`), true);
  document.addEventListener('pointerdown', (e) => log(`pointerdown (${e.pointerType}) on ${where(e)}`), true);
  window.addEventListener('error', (e) => log(`ERROR ${e.message}`));
  document.body.appendChild(box);
  render();
}
