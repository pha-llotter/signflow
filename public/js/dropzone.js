/**
 * Drag-and-drop file selection.
 *
 * Progressive enhancement over a real <input type="file"> inside a <label>:
 * without this script the label still opens the picker, the input still
 * validates, and the form still submits. This adds the drop target, the
 * selected-file summary and up-front validation so an oversized or wrong-typed
 * file is caught here rather than after an upload and a round trip.
 */

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setup(zone) {
  const input = zone.querySelector('input[type=file]');
  const idle = zone.querySelector('[data-dz-idle]');
  const summary = zone.querySelector('[data-dz-file]');
  const nameEl = zone.querySelector('[data-dz-name]');
  const metaEl = zone.querySelector('[data-dz-meta]');
  const clearBtn = zone.querySelector('[data-dz-clear]');
  const errorEl = zone.parentElement.querySelector('[data-dz-error]');
  const maxBytes = (Number(zone.dataset.maxMb) || 25) * 1024 * 1024;

  const accepts = (input.getAttribute('accept') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matches = (file) => {
    if (!accepts.length) return true;
    const name = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();
    return accepts.some((a) =>
      a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a
    );
  };

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
    zone.classList.toggle('is-invalid', !!msg);
  };

  function render() {
    const file = input.files?.[0];
    if (!file) {
      idle.hidden = false;
      summary.hidden = true;
      zone.classList.remove('has-file');
    } else {
      nameEl.textContent = file.name;
      metaEl.textContent = `${formatBytes(file.size)}${file.type ? ` · ${file.type}` : ''}`;
      idle.hidden = true;
      summary.hidden = false;
      zone.classList.add('has-file');
    }
    // The settled state, after validation: a dropped file, a removed one or a
    // rejected one never fires the input's own change event, and a rejected
    // pick fires it before it is cleared. Anything that depends on "is there a
    // file?" listens for this instead.
    zone.dispatchEvent(new CustomEvent('dropzone:change', { bubbles: true, detail: { file: file || null } }));
  }

  /** Returns false and explains why, rather than silently ignoring the file. */
  function accept(file) {
    if (!matches(file)) {
      showError(`${file.name} is not a PDF. Only PDF files can be uploaded.`);
      return false;
    }
    if (file.size > maxBytes) {
      showError(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.`);
      return false;
    }
    showError('');
    return true;
  }

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file && !accept(file)) {
      input.value = '';
    }
    render();
  });

  // Dragging a file over the window fires dragenter/dragleave for every child
  // element it crosses, so track depth rather than toggling on each event.
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

  zone.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add('is-over');
  });

  zone.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('is-over');
  });

  zone.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-over');

    const file = e.dataTransfer.files?.[0];
    if (!file || !accept(file)) return;

    // Assigning through a DataTransfer is the only way to put a dropped file
    // into the input so it travels with a normal form submit.
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    render();
  });

  clearBtn.addEventListener('click', (e) => {
    // The button sits inside the <label>; without this the click falls through
    // and immediately reopens the file picker.
    e.preventDefault();
    e.stopPropagation();
    input.value = '';
    showError('');
    render();
  });

  render();
}

document.querySelectorAll('[data-dropzone]').forEach(setup);

// Dropping a file anywhere else would make the browser navigate away from a
// half-filled form, which looks like the app crashed.
for (const evt of ['dragover', 'drop']) {
  window.addEventListener(evt, (e) => {
    if (e.target.closest('[data-dropzone]')) return;
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
  });
}
