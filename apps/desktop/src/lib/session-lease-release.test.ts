import { describe, expect, it, vi } from "vitest";
import { createSessionLeaseReleaseQueue } from "./session-lease-release";

const lease = { windowId: "window", scope: "recovered", leaseId: "lease" };

describe("uncertain session lease cleanup", () => {
  it("retains a rejected close and retries without exposing an adopted lease", async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue({ ok: true });
    const onError = vi.fn();
    const queue = createSessionLeaseReleaseQueue({ close, onPending: vi.fn(), onError });
    expect(await queue.release(lease)).toBe(false);
    expect(queue.hasPending()).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
    expect(await queue.releaseAll()).toBe(true);
    expect(queue.hasPending()).toBe(false);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("retains unavailable results but clears proven lost ownership", async () => {
    const close = vi.fn().mockResolvedValueOnce({ ok: false, reason: "unavailable" }).mockResolvedValue({ ok: false, reason: "stale-lease" });
    const queue = createSessionLeaseReleaseQueue({ close, onPending: vi.fn(), onError: vi.fn() });
    expect(await queue.release(lease)).toBe(false);
    expect(queue.hasPending()).toBe(true);
    expect(await queue.releaseAll()).toBe(true);
  });
  it("coalesces concurrent release attempts for the exact same lease", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const close = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { finish = resolve; }));
    const queue = createSessionLeaseReleaseQueue({ close, onPending: vi.fn(), onError: vi.fn() });
    const first = queue.release(lease);
    const second = queue.release(lease);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    finish({ ok: true });
    expect(await first).toBe(true);
    expect(queue.hasPending()).toBe(false);
  });
});
