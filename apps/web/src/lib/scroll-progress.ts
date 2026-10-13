import { onCleanup } from "solid-js";

/**
 * Scroll-linked progress for CSS.
 *
 * Each tracked element receives `--p` (0 → 1) that follows the scroll position
 * linearly, eased with a light lerp so motion stays smooth on wheels and
 * trackpads. The document root receives `--page-p` for page-wide progress.
 *
 * Ranges, measured by the element's top edge in the viewport:
 *   enter   bottom of viewport → upper quarter (element arriving)
 *   appear  bottom of viewport → lower third (finished while still readable)
 *   exit    top of viewport → element fully scrolled away
 *   pass    bottom of viewport → element fully scrolled away
 *   pin     top of viewport → bottom aligned with viewport (sticky scenes)
 *   read    reading line (40% down) crosses the element from top to bottom
 */
export type ScrollMode = "enter" | "appear" | "exit" | "pass" | "pin" | "read";

export type ScrollOptions = {
  mode?: ScrollMode;
  onProgress?: (progress: number) => void;
};

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      scroll: ScrollOptions | ScrollMode | true;
    }
  }
}

type Tracked = {
  mode: ScrollMode;
  onProgress?: (progress: number) => void;
  target: number;
  current: number;
  placed: boolean;
};

/** Share of the remaining distance covered per 60 Hz frame; scaled by real frame time. */
const SMOOTHING = 0.16;
const SETTLED = 0.0005;

const tracked = new Map<HTMLElement, Tracked>();
let frame: number | undefined;
let listening = false;
let reducedMotion = false;
let pageCurrent = 0;
let lastTick: number | undefined;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** Layout position, ignoring transforms so scroll-driven motion never feeds back into its own progress. */
function documentTop(element: HTMLElement) {
  let top = 0;
  for (let node: HTMLElement | null = element; node; node = node.offsetParent as HTMLElement | null) {
    top += node.offsetTop;
  }
  return top;
}

function measure(element: HTMLElement, mode: ScrollMode, viewport: number) {
  const top = documentTop(element) - window.scrollY;
  const height = element.offsetHeight;
  const [start, end] =
    mode === "enter" ? [viewport, viewport * 0.25]
    : mode === "appear" ? [viewport, viewport * 0.68]
    : mode === "exit" ? [0, -height]
    : mode === "pin" ? [0, viewport - height]
    : mode === "read" ? [viewport * 0.4, viewport * 0.4 - height]
    : [viewport, -height];
  return start === end ? 1 : clamp01((start - top) / (start - end));
}

function measureAll() {
  const viewport = window.innerHeight;
  for (const [element, state] of tracked) {
    if (state.placed) state.target = measure(element, state.mode, viewport);
  }
}

/** Directives run before their element is attached, so the first measurement waits for layout and snaps. */
function placeNewElements() {
  const viewport = window.innerHeight;
  for (const [element, state] of tracked) {
    if (state.placed || !element.isConnected) continue;
    state.placed = true;
    state.target = measure(element, state.mode, viewport);
    write(element, state, state.target);
  }
}

function write(element: HTMLElement, state: Tracked, value: number) {
  state.current = value;
  element.style.setProperty("--p", value.toFixed(4));
  state.onProgress?.(value);
}

function tick(now: number) {
  frame = undefined;
  const elapsed = lastTick === undefined ? 16.7 : Math.min(now - lastTick, 250);
  lastTick = now;
  const smoothing = 1 - Math.pow(1 - SMOOTHING, elapsed / 16.7);
  let moving = false;
  placeNewElements();

  for (const [element, state] of tracked) {
    if (!state.placed) {
      moving = true;
      continue;
    }
    const delta = state.target - state.current;
    if (Math.abs(delta) < SETTLED || reducedMotion) {
      if (state.current !== state.target) write(element, state, state.target);
      continue;
    }
    write(element, state, state.current + delta * smoothing);
    moving = true;
  }

  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const pageTarget = scrollable > 0 ? clamp01(window.scrollY / scrollable) : 0;
  const pageDelta = pageTarget - pageCurrent;
  pageCurrent = Math.abs(pageDelta) < SETTLED || reducedMotion ? pageTarget : pageCurrent + pageDelta * smoothing;
  document.documentElement.style.setProperty("--page-p", pageCurrent.toFixed(4));
  if (pageCurrent !== pageTarget) moving = true;

  if (moving) schedule();
  else lastTick = undefined;
}

function schedule() {
  frame ??= window.requestAnimationFrame(tick);
}

function onScroll() {
  measureAll();
  schedule();
}

function startListening() {
  if (listening) return;
  listening = true;
  reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  window.addEventListener("load", onScroll);
}

function stopListening() {
  if (!listening || tracked.size > 0) return;
  listening = false;
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onScroll);
  window.removeEventListener("load", onScroll);
  if (frame !== undefined) window.cancelAnimationFrame(frame);
  frame = undefined;
}

export function scroll(element: HTMLElement, value: () => ScrollOptions | ScrollMode | true) {
  const raw = value();
  const options: ScrollOptions = typeof raw === "object" ? raw : { mode: raw === true ? "pass" : raw };
  startListening();

  tracked.set(element, { mode: options.mode ?? "pass", onProgress: options.onProgress, target: 0, current: 0, placed: false });
  schedule();

  onCleanup(() => {
    tracked.delete(element);
    stopListening();
  });
}
