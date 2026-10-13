import { describe, expect, it, vi } from "vitest";
import { fitVisibleTerminal } from "./terminal-fit";

describe("terminal fit visibility", () => {
  it("does not fit a hidden or zero-sized terminal", () => {
    const host = { getBoundingClientRect: () => ({ width: 0, height: 0 } as DOMRect) };
    const fit = vi.fn();

    expect(fitVisibleTerminal(false, host, fit)).toBe(false);
    expect(fitVisibleTerminal(true, host, fit)).toBe(false);
    expect(fit).not.toHaveBeenCalled();
  });

  it("fits after the visible host has real dimensions", () => {
    const host = { getBoundingClientRect: () => ({ width: 640, height: 240 } as DOMRect) };
    const fit = vi.fn();

    expect(fitVisibleTerminal(true, host, fit)).toBe(true);
    expect(fit).toHaveBeenCalledOnce();
  });
});
