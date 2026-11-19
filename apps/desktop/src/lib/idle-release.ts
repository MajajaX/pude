export const IDLE_RELEASE_DELAY_MS = 5 * 60 * 1000;

/**
 * Calls `release` once after the window has stayed hidden for the delay.
 * Becoming visible cancels a pending release and allows the next hidden
 * period to release again.
 */
export function createIdleRelease(release: () => void, delayMs = IDLE_RELEASE_DELAY_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let releasedWhileHidden = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    setHidden(hidden: boolean) {
      if (!hidden) {
        cancel();
        releasedWhileHidden = false;
        return;
      }
      if (timer !== undefined || releasedWhileHidden) return;
      timer = setTimeout(() => {
        timer = undefined;
        releasedWhileHidden = true;
        release();
      }, delayMs);
    },
    dispose: cancel,
  };
}

export type IdleRelease = ReturnType<typeof createIdleRelease>;
