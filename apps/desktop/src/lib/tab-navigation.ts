export type TabListOrientation = "horizontal" | "vertical";
export type TabActivationMode = "automatic" | "manual";

export type TabNavigationInput = {
  key: string;
  count: number;
  focusedIndex: number;
  orientation: TabListOrientation;
  direction?: "ltr" | "rtl";
  activation?: TabActivationMode;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export type TabNavigationAction = {
  handled: boolean;
  preventDefault: boolean;
  focusIndex?: number;
  selectedIndex?: number;
};

const unhandled: TabNavigationAction = { handled: false, preventDefault: false };

/**
 * Computes the keyboard movement for a tablist. The caller owns DOM focus,
 * selection state, and ARIA attributes, so the same helper works for both the
 * editor tab strip and the sidebar tab strip.
 */
export function tabNavigationAction(input: TabNavigationInput): TabNavigationAction {
  const { key, count } = input;
  if (input.isComposing || input.keyCode === 229 || input.ctrlKey || input.altKey || input.metaKey || count <= 0) return unhandled;

  const currentIndex = Number.isFinite(input.focusedIndex)
    ? Math.min(Math.max(Math.trunc(input.focusedIndex), 0), count - 1)
    : 0;
  let targetIndex: number | undefined;

  if (key === "Home") targetIndex = 0;
  else if (key === "End") targetIndex = count - 1;
  else if (input.orientation === "horizontal" && (key === "ArrowLeft" || key === "ArrowRight")) {
    const direction = input.direction ?? "ltr";
    const forward = key === (direction === "rtl" ? "ArrowLeft" : "ArrowRight");
    targetIndex = wrapIndex(currentIndex + (forward ? 1 : -1), count);
  } else if (input.orientation === "vertical" && (key === "ArrowUp" || key === "ArrowDown")) {
    targetIndex = wrapIndex(currentIndex + (key === "ArrowDown" ? 1 : -1), count);
  } else if ((key === "Enter" || key === " " || key === "Spacebar") && input.activation === "manual") {
    return { handled: true, preventDefault: true, selectedIndex: currentIndex };
  } else {
    return unhandled;
  }

  const action: TabNavigationAction = {
    handled: true,
    preventDefault: true,
    focusIndex: targetIndex,
  };
  if ((input.activation ?? "automatic") === "automatic") action.selectedIndex = targetIndex;
  return action;
}

/** Returns the sole sequential tab stop for a tablist. */
export function tabRovingIndex(tabIndex: number, focusedIndex: number): 0 | -1 {
  return tabIndex === focusedIndex ? 0 : -1;
}

function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}
