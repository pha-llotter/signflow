/**
 * Signature capture: draw, type or upload.
 *
 * Everything comes back as a trimmed transparent PNG data URL, so the stamper
 * has one shape to deal with and the signature keeps its own aspect ratio
 * inside whatever box the author drew.
 */

const CURSIVE = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';

function shell(title, sub, body, footerId = 'sp-ok') {
  return `<h2>${title}</h2><p class="sub">${sub}</p>${body}
    <div class="btn-row" style="margin-top:16px">
      <button class="btn" id="${footerId}">Apply</button>
      <button class="btn btn-ghost" id="sp-clear">Clear</button>
      <button class="btn btn-ghost" id="sp-cancel" style="margin-left:auto">Cancel</button>
    </div>`;
}

function mount(html) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  document.body.appendChild(back);
  return back;
}

/** Freehand drawing bound to one canvas, with pointer + touch support. */
function attachPad(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let drawn = false;

  const size = () => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#10233f';
  };
  size();

  let drawing = false;
  let last = null;

  const point = (e) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    drawing = true;
    drawn = true;
    last = point(e);
    canvas.setPointerCapture(e.pointerId);
    // A tap with no movement should still leave a dot.
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = '#10233f';
    ctx.fill();
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });

  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointerleave', stop);
  canvas.addEventListener('pointercancel', stop);

  return {
    clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); drawn = false; },
    hasInk() { return drawn; },
    export: () => trim(canvas),
  };
}

/**
 * Crops the transparent margin off a canvas. Without this a signature drawn in
 * the corner of the pad would be centred as if it filled the whole box, and
 * land in the wrong place on the page.
 */
function trim(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const { data } = ctx.getImageData(0, 0, w, h);

  let top = h, left = w, right = 0, bottom = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (right <= left || bottom <= top) return null;

  const pad = 6;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(w - 1, right + pad);
  bottom = Math.min(h - 1, bottom + pad);

  const out = document.createElement('canvas');
  out.width = right - left + 1;
  out.height = bottom - top + 1;
  out.getContext('2d').drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Renders typed text to a transparent PNG at print resolution. */
function typedToPng(text) {
  const value = String(text || '').trim();
  if (!value) return null;

  const scale = 3;
  const fontSize = 64;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = `${fontSize}px ${CURSIVE}`;
  const width = Math.ceil(measure.measureText(value).width) + 40;

  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = Math.ceil(fontSize * 1.6) * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.font = `${fontSize}px ${CURSIVE}`;
  ctx.fillStyle = '#10233f';
  ctx.textBaseline = 'middle';
  ctx.fillText(value, 20, (fontSize * 1.6) / 2);
  return trim(canvas);
}

function initialsOf(name) {
  return String(name || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('.')
    .concat('.');
}

export function openSignaturePad({ name, initialsOnly = false } = {}) {
  const suggested = initialsOnly ? initialsOf(name) : name || '';

  const back = mount(
    shell(
      initialsOnly ? 'Your initials' : 'Your signature',
      'Draw it, type it, or upload an image of it. Whichever you choose is sealed into the final PDF.',
      `<div class="tabs">
         <button class="active" data-tab="draw">Draw</button>
         <button data-tab="type">Type</button>
         <button data-tab="upload">Upload</button>
       </div>
       <div data-panel="draw">
         <div class="pad-wrap"><canvas id="sp-canvas"></canvas><div class="baseline"></div></div>
       </div>
       <div data-panel="type" hidden>
         <div class="field"><input type="text" id="sp-typed" value="${suggested.replace(/"/g, '&quot;')}"></div>
         <div class="typed-preview" id="sp-preview">${suggested || '&nbsp;'}</div>
       </div>
       <div data-panel="upload" hidden>
         <div class="field"><input type="file" id="sp-file" accept="image/png,image/jpeg"></div>
         <div class="typed-preview" id="sp-uploaded"><span class="hint">A PNG with a transparent background works best.</span></div>
       </div>`
    )
  );

  const modal = back.querySelector('.modal');
  const pad = attachPad(modal.querySelector('#sp-canvas'));
  let tab = 'draw';
  let uploaded = null;

  modal.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      modal.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      modal.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
    });
  });

  const typed = modal.querySelector('#sp-typed');
  const preview = modal.querySelector('#sp-preview');
  typed.addEventListener('input', () => { preview.textContent = typed.value || ' '; });

  modal.querySelector('#sp-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      uploaded = reader.result;
      modal.querySelector('#sp-uploaded').innerHTML =
        `<img src="${uploaded}" style="max-height:100px;max-width:100%">`;
    };
    reader.readAsDataURL(file);
  });

  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };

    modal.querySelector('#sp-clear').addEventListener('click', () => {
      if (tab === 'draw') pad.clear();
      else if (tab === 'type') { typed.value = ''; preview.textContent = ' '; }
      else { uploaded = null; modal.querySelector('#sp-uploaded').innerHTML = '<span class="hint">No file chosen.</span>'; }
    });

    modal.querySelector('#sp-cancel').addEventListener('click', () => close(null));
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });

    modal.querySelector('#sp-ok').addEventListener('click', () => {
      let out = null;
      if (tab === 'draw') out = pad.hasInk() ? pad.export() : null;
      else if (tab === 'type') out = typedToPng(typed.value);
      else out = uploaded;

      if (!out) {
        alert(tab === 'draw' ? 'Draw your signature first.' : tab === 'type' ? 'Type your name first.' : 'Choose an image first.');
        return;
      }
      close(out);
    });
  });
}

export function openDrawingPad() {
  const back = mount(
    shell('Draw on the document', 'Sketch or mark up anything you need to. It is drawn into the sealed PDF.',
      `<div class="pad-wrap"><canvas id="sp-canvas" style="height:230px"></canvas></div>`)
  );
  const modal = back.querySelector('.modal');
  const pad = attachPad(modal.querySelector('#sp-canvas'));

  return new Promise((resolve) => {
    const close = (v) => { back.remove(); resolve(v); };
    modal.querySelector('#sp-clear').addEventListener('click', () => pad.clear());
    modal.querySelector('#sp-cancel').addEventListener('click', () => close(null));
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    modal.querySelector('#sp-ok').addEventListener('click', () => {
      if (!pad.hasInk()) { alert('Draw something first.'); return; }
      close(pad.export());
    });
  });
}
