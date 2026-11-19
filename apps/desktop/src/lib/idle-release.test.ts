import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleRelease, IDLE_RELEASE_DELAY_MS } from "./idle-release";

describe("idle release", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("releases after the window has been hidden for five minutes", () => {
    const release = vi.fn();
    createIdleRelease(release).setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS - 1);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(IDLE_RELEASE_DELAY_MS).toBe(300_000);
  });

  it("cancels when the window becomes visible first", () => {
    const release = vi.fn();
    const idle = createIdleRelease(release);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS - 1_000);
    idle.setHidden(false);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS);
    expect(release).not.toHaveBeenCalled();
  });

  it("does not restart the countdown for repeated hidden reports", () => {
    const release = vi.fn();
    const idle = createIdleRelease(release);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS / 2);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS / 2);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases once per hidden period and again after the window returns", () => {
    const release = vi.fn();
    const idle = createIdleRelease(release);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS);
    expect(release).toHaveBeenCalledTimes(1);
    idle.setHidden(false);
    idle.setHidden(true);
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("stops a pending release when disposed", () => {
    const release = vi.fn();
    const idle = createIdleRelease(release);
    idle.setHidden(true);
    idle.dispose();
    vi.advanceTimersByTime(IDLE_RELEASE_DELAY_MS);
    expect(release).not.toHaveBeenCalled();
  });
});
