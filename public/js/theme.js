/**
 * Theme switching.
 *
 * The resolved theme is already on <html> by the time this runs — an inline
 * script in the page head does that before first paint. This file only handles
 * the toggle and keeps following the OS until the user makes an explicit
 * choice, after which their choice wins on every device and every visit.
 */
const KEY = 'signflow-theme';
const root = document.documentElement;

const stored = () => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
};

function apply(theme) {
  root.setAttribute('data-theme', theme);
  for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
  }
}

for (const btn of document.querySelectorAll('[data-theme-toggle]')) {
  btn.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private mode or storage disabled — the choice still applies for this
      // page load, it just will not be remembered.
    }
    apply(next);
  });
}

// Follow the OS only while the user has not chosen for themselves.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => {
  if (!stored()) apply(e.matches ? 'dark' : 'light');
});

apply(root.getAttribute('data-theme') || 'light');
