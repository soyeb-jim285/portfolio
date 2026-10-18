// Movement shared by the log variants. Each variant calls only the pieces it uses, and every one
// of them is a no-op when the visitor asked for reduced motion.
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Add `in` to each element the first time it enters the frame. */
export function reveal(selector: string, options: { threshold?: number; stagger?: boolean } = {}) {
  const targets = document.querySelectorAll<HTMLElement>(selector);
  if (!targets.length) return;
  if (reduced()) { targets.forEach((target) => target.classList.add('in')); return; }
  if (options.stagger) {
    // Neighbours that arrive together follow each other in rather than landing as a block.
    let last = 0;
    targets.forEach((target, i) => {
      const step = i === 0 ? 0 : Math.min(0.24, (i - last) * 0.06);
      target.style.setProperty('--d', `${step}s`);
      if (step === 0) last = i;
    });
  }
  const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add('in');
    seen.unobserve(entry.target);
  }), { threshold: options.threshold ?? 0.15, rootMargin: '0px 0px -8% 0px' });
  targets.forEach((target) => seen.observe(target));
}

/** Draw every `.draw-me` stroke inside a figure once that figure is on screen. */
export function drawPlots(selector = '.plot') {
  const plots = document.querySelectorAll<SVGSVGElement>(selector);
  if (!plots.length) return;
  if (reduced()) { plots.forEach((plot) => plot.classList.add('in')); return; }
  const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const plot = entry.target as SVGSVGElement;
    plot.querySelectorAll<SVGGeometryElement>('.draw-me').forEach((stroke, i) => {
      const length = stroke.getTotalLength();
      stroke.style.strokeDasharray = String(length);
      stroke.style.strokeDashoffset = String(length);
      void stroke.getBoundingClientRect();
      stroke.style.transition = `stroke-dashoffset 1s cubic-bezier(.65,0,.35,1) ${i * 0.08}s`;
      stroke.style.strokeDashoffset = '0';
    });
    plot.classList.add('in');
    seen.unobserve(plot);
  }), { threshold: 0.2 });
  plots.forEach((plot) => seen.observe(plot));
}

/** Roll a readout up to its printed value the first time it is seen. */
export function countUp(selector: string) {
  const cells = document.querySelectorAll<HTMLElement>(selector);
  if (!cells.length || reduced()) return;
  const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (!entry.isIntersecting) return;
    const cell = entry.target as HTMLElement;
    const target = Number(cell.textContent);
    if (!Number.isFinite(target)) { seen.unobserve(cell); return; }
    const decimals = (cell.textContent ?? '').split('.')[1]?.length ?? 0;
    const started = performance.now();
    const tick = (now: number) => {
      // Ease out, so the number settles rather than stopping dead on its value.
      const t = Math.min((now - started) / 900, 1);
      cell.textContent = (target * (1 - Math.pow(1 - t, 3))).toFixed(decimals);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    seen.unobserve(cell);
  }), { threshold: 0.6 });
  cells.forEach((cell) => seen.observe(cell));
}

/** Light the index entry for the section being read, and show how far down the sheet it is. */
export function trackSections(linkSelector: string, sectionSelector: string, bar?: string) {
  const links = new Map<string, HTMLElement>();
  document.querySelectorAll<HTMLElement>(linkSelector).forEach((link) => links.set(link.dataset.for!, link));
  const sections = [...document.querySelectorAll<HTMLElement>(sectionSelector)];
  if (!sections.length) return;
  const fill = bar ? document.querySelector<HTMLElement>(bar) : null;

  // Chosen on scroll rather than by observer: the reader is always inside some section, including
  // the last one, where an observer watching a band of the viewport reports nothing.
  const onScroll = () => {
    const current = sections.reduce<HTMLElement | null>(
      (found, section) => (section.getBoundingClientRect().top <= 160 ? section : found), sections[0]);
    links.forEach((link) => link.classList.remove('on'));
    if (current) links.get(current.id)?.classList.add('on');
    if (!fill) return;
    const height = document.documentElement.scrollHeight - window.innerHeight;
    fill.style.setProperty('--p', `${height > 0 ? Math.min(100, (window.scrollY / height) * 100) : 0}%`);
  };
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
}
