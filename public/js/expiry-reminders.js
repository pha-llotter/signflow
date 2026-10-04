/**
 * Keeps the reminder choice inside the expiry. An interval as long as the time
 * allowed to sign would remind people after their link had stopped working, so
 * those options are greyed out as the expiry is typed, and a choice that no
 * longer fits drops to the longest one that does (or Off). The server applies
 * the same rule; this just shows it before the form is sent.
 */
const expiry = document.getElementById('expires_in_days');
const select = document.getElementById('reminder_days');

if (expiry && select) {
  const options = [...select.options];

  const sync = () => {
    const days = Number(expiry.value);
    if (!Number.isFinite(days) || days < 1) return; // half-typed — wait for a number
    for (const o of options) {
      const interval = Number(o.value);
      o.disabled = interval > 0 && interval >= days;
    }
    if (select.selectedOptions[0]?.disabled) {
      const fits = options.filter((o) => !o.disabled);
      fits[fits.length - 1].selected = true; // longest that fits; Off is always first
    }
  };

  expiry.addEventListener('input', sync);
  sync();
}
