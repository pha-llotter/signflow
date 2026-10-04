/**
 * The pages pane: a small picture of every page, in a column beside the
 * document. Clicking one scrolls the document there, the page in view is
 * highlighted as you scroll, and each thumbnail carries small marks where the
 * fields are — so a long document shows at a glance where the work is.
 *
 * Shared by the placer and the signing page. Thumbnails are rendered once at a
 * fixed small size; zooming the document does not touch them.
 */
const THUMB_WIDTH = 150;

export function createThumbs({ pdf, list, scroller, pageEls, markClass }) {
  const items = [];

  async function build() {
    list.innerHTML = '';
    items.length = 0;
    for (let i = 0; i < pdf.numPages; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'thumb';
      btn.dataset.page = String(i);
      btn.setAttribute('aria-label', `Go to page ${i + 1}`);

      const paper = document.createElement('span');
      paper.className = 'thumb-paper';
      const canvas = document.createElement('canvas');
      const marks = document.createElement('span');
      marks.className = 'thumb-marks';
      paper.append(canvas, marks);

      const num = document.createElement('span');
      num.className = 'thumb-num';
      num.textContent = String(i + 1);

      btn.append(paper, num);
      btn.addEventListener('click', () => goTo(i));
      list.appendChild(btn);
      items.push({ btn, canvas, marks });
    }
    // Pictures after the buttons exist, so the pane has its shape straight away.
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const natural = page.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (THUMB_WIDTH / natural.width) * dpr });
      const { canvas } = items[i];
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    }
    track();
  }

  function goTo(i) {
    const target = pageEls()[i];
    if (!target) return;
    const top = target.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
    const root = scroller();
    // The signing page scrolls the window; the placer scrolls its own column.
    if (root === document.documentElement) window.scrollBy({ top: top - 120, behavior: 'smooth' });
    else root.scrollBy({ top: top - 16, behavior: 'smooth' });
  }

  /** Field marks: [{ page, x, y, w, h, color, state }] in page fractions. */
  function mark(fields) {
    items.forEach((it) => (it.marks.innerHTML = ''));
    for (const f of fields) {
      const it = items[f.page];
      if (!it) continue;
      const m = document.createElement('span');
      m.className = `thumb-mark ${markClass ? markClass(f) : ''}`;
      m.style.cssText = `left:${f.x * 100}%;top:${f.y * 100}%;width:${f.w * 100}%;height:${f.h * 100}%;` +
        (f.color ? `--mark:${f.color}` : '');
      it.marks.appendChild(m);
    }
  }

  /** Highlights the page that fills most of the view. */
  function track() {
    const pages = pageEls();
    if (!pages.length || !items.length) return;
    const root = scroller();
    const box = root === document.documentElement
      ? { top: 0, bottom: window.innerHeight }
      : root.getBoundingClientRect();
    let best = 0, bestSeen = -1;
    pages.forEach((p, i) => {
      const r = p.getBoundingClientRect();
      const seen = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      if (seen > bestSeen) { bestSeen = seen; best = i; }
    });
    items.forEach((it, i) => {
      const on = i === best;
      if (on && !it.btn.classList.contains('current')) {
        // Keep the highlighted thumbnail in view. Scrolled by hand: scrollIntoView
        // would scroll the document too, fighting the person scrolling it.
        const lr = list.getBoundingClientRect(), br = it.btn.getBoundingClientRect();
        if (br.top < lr.top) list.scrollTop -= lr.top - br.top + 8;
        else if (br.bottom > lr.bottom) list.scrollTop += br.bottom - lr.bottom + 8;
      }
      it.btn.classList.toggle('current', on);
      if (on) it.btn.setAttribute('aria-current', 'page'); else it.btn.removeAttribute('aria-current');
    });
  }

  let raf = 0;
  const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(track); };
  const root = scroller();
  (root === document.documentElement ? window : root).addEventListener('scroll', onScroll, { passive: true });

  return { build, mark, track };
}
