const modalSelector = '[role="dialog"][aria-modal="true"]';
const focusableSelector = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[tabindex]",
  '[contenteditable="true"]',
].join(",");

type ModalOrigin = {
  target: HTMLElement | null;
  containingModal: HTMLElement | null;
  fallbackTarget: HTMLElement | null;
  fallbackContainingModal: HTMLElement | null;
};

export type ModalFocusOptions = {
  initialFocus?: () => HTMLElement | null | undefined;
  returnFocus?: HTMLElement | null | (() => HTMLElement | null | undefined);
};

export type ModalFocusController = {
  isTopmost(): boolean;
  handleKeyDown(event: KeyboardEvent): void;
  focusFirst(): HTMLElement | null;
  focusLast(): HTMLElement | null;
  focusDialog(): void;
  dispose(): void;
};

type ModalEntry = {
  dialog: HTMLElement;
  origin: ModalOrigin;
  options: ModalFocusOptions;
};

const entries: ModalEntry[] = [];
const modalOrigins = new WeakMap<HTMLElement, ModalOrigin>();
let sharedFocusListener: ((event: FocusEvent) => void) | undefined;

/**
 * Register a dialog with the shared focus lifecycle. There is one document
 * focusin listener for all active dialogs; key trapping and focusable lookup
 * are shared methods so each dialog keeps its own Enter/Escape policy.
 */
export function activateModalFocus(dialog: HTMLElement, options: ModalFocusOptions = {}): ModalFocusController {
  const configuredOrigin = resolveConfiguredOrigin(options.returnFocus);
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const capturedOrigin = activeElement && activeElement.isConnected && activeElement !== document.body && activeElement !== document.documentElement
    ? activeElement
    : null;
  const primaryOrigin = capturedOrigin ?? configuredOrigin;
  const origin: ModalOrigin = {
    target: primaryOrigin,
    containingModal: primaryOrigin?.closest<HTMLElement>(modalSelector) ?? null,
    fallbackTarget: capturedOrigin ? configuredOrigin : null,
    fallbackContainingModal: capturedOrigin ? configuredOrigin?.closest<HTMLElement>(modalSelector) ?? null : null,
  };
  const entry: ModalEntry = { dialog, origin, options };
  entries.push(entry);
  modalOrigins.set(dialog, origin);
  installSharedFocusListener();

  const controller: ModalFocusController = {
    isTopmost: () => isTopmostModal(dialog),
    handleKeyDown: (event) => trapTab(dialog, event),
    focusFirst: () => focusFirstIn(dialog),
    focusLast: () => focusLastIn(dialog),
    focusDialog: () => focusDialog(dialog),
    dispose: () => {
      const index = entries.indexOf(entry);
      if (index < 0) return;
      const wasTopmost = isTopmostModal(dialog);
      entries.splice(index, 1);
      if (entries.length === 0) removeSharedFocusListener();
      if (wasTopmost) window.setTimeout(() => restoreFocusAfterModal(origin), 0);
    },
  };

  if (controller.isTopmost()) focusInitial(entry);
  return controller;
}

/** Compatibility helpers for callers being migrated to activateModalFocus. */
export function isTopmostModal(dialog: HTMLElement | undefined): boolean {
  return Boolean(dialog && getTopmostModal() === dialog);
}

export function rememberModalFocus(dialog: HTMLElement | undefined, focusTarget: HTMLElement | null): void {
  if (!dialog) return;
  modalOrigins.set(dialog, {
    target: focusTarget,
    containingModal: focusTarget?.closest<HTMLElement>(modalSelector) ?? null,
    fallbackTarget: null,
    fallbackContainingModal: null,
  });
}

export function restoreFocusAfterModalClose(dialog: HTMLElement | undefined, focusTarget: HTMLElement | null): void {
  if (!dialog) return;
  const origin = modalOrigins.get(dialog) ?? {
    target: focusTarget,
    containingModal: focusTarget?.closest<HTMLElement>(modalSelector) ?? null,
    fallbackTarget: null,
    fallbackContainingModal: null,
  };
  window.setTimeout(() => restoreFocusAfterModal({ ...origin, target: focusTarget ?? origin.target }), 0);
}

export function getModalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(isFocusable)
    .sort(compareTabOrder);
}

function installSharedFocusListener(): void {
  if (sharedFocusListener) return;
  sharedFocusListener = (event) => {
    const topmost = getTopmostModal();
    if (!topmost || !(event.target instanceof Node) || topmost.contains(event.target)) return;
    focusFirstIn(topmost);
  };
  document.addEventListener("focusin", sharedFocusListener, true);
}

function removeSharedFocusListener(): void {
  if (!sharedFocusListener) return;
  document.removeEventListener("focusin", sharedFocusListener, true);
  sharedFocusListener = undefined;
}

function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "Tab" || !isTopmostModal(dialog)) return;
  const focusable = getModalFocusableElements(dialog);
  if (focusable.length === 0) {
    event.preventDefault();
    focusDialog(dialog);
    return;
  }

  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  if (event.shiftKey && currentIndex <= 0) {
    event.preventDefault();
    focusElement(focusable[focusable.length - 1]);
  } else if (!event.shiftKey && (currentIndex < 0 || currentIndex === focusable.length - 1)) {
    event.preventDefault();
    focusElement(focusable[0]);
  }
}

function focusInitial(entry: ModalEntry): void {
  let target: HTMLElement | null | undefined;
  try {
    target = entry.options.initialFocus?.();
  } catch {
    target = null;
  }
  if (target && entry.dialog.contains(target) && isFocusable(target)) {
    focusElement(target);
    return;
  }
  focusFirstIn(entry.dialog);
}

function focusFirstIn(dialog: HTMLElement): HTMLElement | null {
  const target = getModalFocusableElements(dialog)[0] ?? null;
  if (target) {
    focusElement(target);
    return target;
  }
  focusDialog(dialog);
  return null;
}

function focusLastIn(dialog: HTMLElement): HTMLElement | null {
  const focusable = getModalFocusableElements(dialog);
  const target = focusable[focusable.length - 1] ?? null;
  if (target) focusElement(target);
  else focusDialog(dialog);
  return target;
}

function focusDialog(dialog: HTMLElement): void {
  if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
  focusElement(dialog);
}

function focusElement(element: HTMLElement): boolean {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
  return document.activeElement === element;
}

function restoreFocusAfterModal(origin: ModalOrigin): void {
  const topmost = getTopmostModal();
  if (topmost) {
    const target = resolveOrigin(origin);
    if (target && target.isConnected && target.closest<HTMLElement>(modalSelector) === topmost && focusElement(target)) return;
    focusFirstIn(topmost);
    return;
  }

  const target = resolveOrigin(origin);
  if (target && target.isConnected && !target.closest(modalSelector) && focusElement(target)) return;

  const fallback = resolveOrigin({ target: origin.fallbackTarget, containingModal: origin.fallbackContainingModal, fallbackTarget: null, fallbackContainingModal: null });
  if (fallback && fallback.isConnected && !fallback.closest(modalSelector) && focusElement(fallback)) return;

  focusSafeDocumentFallback();
}

function resolveOrigin(origin: ModalOrigin): HTMLElement | null {
  let target = origin.target;
  let modal = origin.containingModal;
  const visited = new Set<HTMLElement>();
  while (!target?.isConnected && modal && !visited.has(modal)) {
    visited.add(modal);
    if (modal.isConnected) return getModalFocusableElements(modal)[0] ?? modal;
    const parentOrigin = modalOrigins.get(modal);
    if (!parentOrigin) return null;
    target = parentOrigin.target ?? parentOrigin.fallbackTarget;
    modal = parentOrigin.containingModal ?? parentOrigin.fallbackContainingModal;
  }
  return target?.isConnected ? target : null;
}

function resolveConfiguredOrigin(value: ModalFocusOptions["returnFocus"]): HTMLElement | null {
  if (typeof value === "function") {
    try {
      return value() ?? null;
    } catch {
      return null;
    }
  }
  return value ?? null;
}

function focusSafeDocumentFallback(): void {
  const main = document.querySelector<HTMLElement>("main, [role='main']");
  if (main && isVisible(main) && !main.closest(modalSelector)) {
    if (main.tabIndex < 0) main.tabIndex = -1;
    if (focusElement(main)) return;
  }

  const target = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector))
    .find((element) => isFocusable(element) && !element.closest(modalSelector));
  if (target && focusElement(target)) return;

  if (document.body) {
    if (document.body.tabIndex < 0) document.body.tabIndex = -1;
    focusElement(document.body);
  }
}

function getTopmostModal(): HTMLElement | undefined {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(modalSelector)).filter(isVisible);
  let topmost = dialogs[0];
  for (const candidate of dialogs.slice(1)) {
    if (compareStackingOrder(candidate, topmost) > 0) topmost = candidate;
  }
  return topmost;
}

function isVisible(dialog: HTMLElement): boolean {
  if (!dialog.isConnected || dialog.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  const style = window.getComputedStyle(dialog);
  return style.display !== "none" && style.visibility !== "hidden" && dialog.getClientRects().length > 0;
}

function compareStackingOrder(left: HTMLElement, right: HTMLElement): number {
  const leftPath = stackingPath(left);
  const rightPath = stackingPath(right);
  const sharedDepth = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < sharedDepth; index += 1) {
    if (leftPath[index] !== rightPath[index]) return leftPath[index] - rightPath[index];
  }
  if (leftPath.length !== rightPath.length) return leftPath.length - rightPath.length;
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

function stackingPath(dialog: HTMLElement): number[] {
  const ancestors: HTMLElement[] = [];
  let element: HTMLElement | null = dialog;
  while (element && element !== document.documentElement) {
    ancestors.push(element);
    element = element.parentElement;
  }
  return ancestors.reverse().flatMap((ancestor) => {
    const value = window.getComputedStyle(ancestor).zIndex;
    const zIndex = Number.parseInt(value, 10);
    return value !== "auto" && Number.isFinite(zIndex) ? [zIndex] : [];
  });
}

function isFocusable(element: HTMLElement): boolean {
  if (!element.isConnected || element.tabIndex < 0 || element.matches(":disabled")) return false;
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
  return element.getClientRects().length > 0;
}

function compareTabOrder(left: HTMLElement, right: HTMLElement): number {
  const leftTabIndex = left.tabIndex;
  const rightTabIndex = right.tabIndex;
  if (leftTabIndex > 0 || rightTabIndex > 0) {
    if (leftTabIndex <= 0) return 1;
    if (rightTabIndex <= 0) return -1;
    if (leftTabIndex !== rightTabIndex) return leftTabIndex - rightTabIndex;
  }
  return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}
