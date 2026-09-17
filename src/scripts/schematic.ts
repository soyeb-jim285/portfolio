// Schematic: strokes draw themselves on scroll, block <-> spec row hover link.
let observer: IntersectionObserver | null = null;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The strokes use non-scaling-stroke, so a dash is measured in screen pixels while
// getTotalLength reports user units. A drawing scaled up by its viewBox needs the screen length,
// or the dash is too short and part of the line is painted before the animation starts.
function prime(stroke: SVGGeometryElement) {
  const matrix = stroke.getScreenCTM();
  const scale = matrix ? Math.hypot(matrix.a, matrix.b) : 1;
  const length = stroke.getTotalLength() * (scale || 1);
  stroke.style.transition = 'none';
  stroke.style.strokeDasharray = String(length);
  stroke.style.strokeDashoffset = String(length);
}

export function init() {
  observer?.disconnect();
  const strokes = document.querySelectorAll<SVGGeometryElement>('.draw path.draw-me, .draw line.draw-me, .draw polyline.draw-me');
  const targets = document.querySelectorAll<HTMLElement>('.draw');
  if (reduced()) { targets.forEach(target => target.classList.add('in')); return; }
  // Hidden until primed, so a stroke is never shown full-length before its figure scrolls in.
  strokes.forEach(stroke => { stroke.style.transition = 'none'; stroke.style.strokeDashoffset = '0'; stroke.style.opacity = '0'; });
  observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const target = entry.target as HTMLElement;
    target.classList.add('in');
    const parts = target.querySelectorAll<SVGGeometryElement>('.draw-me');
    if (target.matches('svg.draw')) target.style.setProperty('--label-delay', `${Math.min(1, parts.length * 0.05 + 0.3)}s`);
    // Strokes inside a [data-lane] group stagger within their own lane, so two columns draw side
    // by side instead of one after the other. Anything outside a lane starts once the longest
    // lane has finished, which is where a diagram's converging tail belongs.
    const lanes = new Map<Element, SVGGeometryElement[]>();
    const loose: SVGGeometryElement[] = [];
    parts.forEach(stroke => {
      const lane = stroke.closest('[data-lane]');
      if (lane && target.contains(lane)) (lanes.get(lane) ?? lanes.set(lane, []).get(lane)!).push(stroke);
      else loose.push(stroke);
    });
    const longest = Math.max(0, ...[...lanes.values()].map(lane => lane.length));
    const step = (stroke: SVGGeometryElement) => {
      const lane = stroke.closest('[data-lane]');
      return lane && lanes.has(lane) ? lanes.get(lane)!.indexOf(stroke) : longest + loose.indexOf(stroke);
    };
    parts.forEach(stroke => {
      // Primed here rather than at load: the scale is only known once the figure has its size.
      stroke.style.removeProperty('opacity');
      prime(stroke);
      void stroke.getBoundingClientRect();
      stroke.style.removeProperty('transition');
      stroke.style.transitionDelay = `${step(stroke) * 0.1}s`;
      stroke.style.strokeDashoffset = '0';
      // Drop the dash once drawn, so a later resize cannot reopen a gap in a finished stroke.
      stroke.addEventListener('transitionend', () => { stroke.style.strokeDasharray = 'none'; }, { once: true });
    });
    observer?.unobserve(target);
  }), { threshold: 0.15 });
  targets.forEach(target => observer!.observe(target));
}

// Hover a diagram block and its spec row lights up, and the other way round.
function highlight(event: Event, on: boolean) {
  const key = (event.target as Element).closest?.('[data-blk]')?.getAttribute('data-blk');
  if (!key) return;
  document.querySelectorAll(`[data-blk="${key}"]`).forEach(element => element.classList.toggle('hot', on));
}
document.addEventListener('mouseover', event => highlight(event, true));
document.addEventListener('mouseout', event => highlight(event, false));
document.addEventListener('astro:before-swap', () => { observer?.disconnect(); observer = null; });
