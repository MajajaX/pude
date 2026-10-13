import { onCleanup } from "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      reveal: boolean;
    }
  }
}

let observer: IntersectionObserver | undefined;
const observedElements = new Set<Element>();

function disposeObserverIfUnused() {
  if (observedElements.size > 0 || !observer) return;
  observer.disconnect();
  observer = undefined;
}

function unobserveElement(element: Element) {
  if (!observedElements.delete(element)) return;
  observer?.unobserve(element);
  disposeObserverIfUnused();
}

function observeElement(element: Element) {
  if (element.classList.contains("is-visible") || observedElements.has(element)) return;
  observedElements.add(element);
  getObserver().observe(element);
}

function getObserver() {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          unobserveElement(entry.target);
        }
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );
  return observer;
}

export function reveal(el: HTMLElement) {
  el.classList.add("reveal");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.classList.add("is-visible");
  } else {
    observeElement(el);
  }
  onCleanup(() => unobserveElement(el));
}

export function refreshReveals() {
  const elements = new Set<Element>(document.querySelectorAll<HTMLElement>(".reveal"));

  for (const element of [...observedElements]) {
    if (!elements.has(element)) unobserveElement(element);
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const element of elements) element.classList.add("is-visible");
    return;
  }

  for (const element of elements) observeElement(element);
}
