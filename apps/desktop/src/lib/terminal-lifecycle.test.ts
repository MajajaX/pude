import { describe, expect, it, vi } from "vitest";
import { TerminalLifecycle } from "./terminal-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

describe("terminal lifecycle", () => {
  it("serializes workspace changes and stops the previous PTY before starting the next", async () => {
    const calls: string[] = [];
    const lifecycle = new TerminalLifecycle({
      start: vi.fn(async (workspace) => {
        calls.push(`start:${workspace}`);
        return `session:${workspace}`;
      }),
      stop: vi.fn(async (sessionId) => { calls.push(`stop:${sessionId}`); }),
    });

    await lifecycle.start("workspace-a");
    await lifecycle.start("workspace-b");

    expect(calls).toEqual([
      "start:workspace-a",
      "stop:session:workspace-a",
      "start:workspace-b",
    ]);
  });

  it("kills a session whose start resolves after a stop request", async () => {
    const starting = deferred<string>();
    const startEntered = deferred<void>();
    const calls: string[] = [];
    const lifecycle = new TerminalLifecycle({
      start: vi.fn(() => {
        startEntered.resolve();
        return starting.promise;
      }),
      stop: vi.fn(async (sessionId) => { calls.push(`stop:${sessionId}`); }),
    });

    const start = lifecycle.start("workspace");
    await startEntered.promise;
    const stop = lifecycle.stop();
    starting.resolve("late-session");

    await expect(start).resolves.toBeUndefined();
    await stop;
    expect(calls).toEqual(["stop:late-session"]);
  });

  it("keeps rapid starts to one active PTY and cancels the stale start", async () => {
    const firstStart = deferred<string>();
    const startEntered = deferred<void>();
    const calls: string[] = [];
    const backendStart = vi.fn()
      .mockImplementationOnce(() => {
        startEntered.resolve();
        return firstStart.promise;
      })
      .mockImplementationOnce(async (workspace: string) => {
        calls.push(`start:${workspace}`);
        return `session:${workspace}`;
      });
    const lifecycle = new TerminalLifecycle({
      start: backendStart,
      stop: vi.fn(async (sessionId) => { calls.push(`stop:${sessionId}`); }),
    });

    const first = lifecycle.start("stale-workspace");
    await startEntered.promise;
    const second = lifecycle.start("current-workspace");
    firstStart.resolve("stale-session");

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe("session:current-workspace");
    expect(calls).toEqual(["stop:stale-session", "start:current-workspace"]);
    expect(backendStart).toHaveBeenCalledTimes(2);
  });

  it("does not stop a session twice after its child exits", async () => {
    const stop = vi.fn(async () => undefined);
    const lifecycle = new TerminalLifecycle({
      start: vi.fn(async () => "session"),
      stop,
    });

    await lifecycle.start("workspace");
    lifecycle.sessionEnded("session");
    await lifecycle.stop();

    expect(stop).not.toHaveBeenCalled();
  });

  it("retains a session after cleanup fails so a later stop can retry it", async () => {
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValue(undefined);
    const lifecycle = new TerminalLifecycle({
      start: vi.fn(async () => "session"),
      stop,
    });

    await lifecycle.start("workspace");
    await expect(lifecycle.stop()).rejects.toThrow("cleanup failed");
    await lifecycle.stop();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenNthCalledWith(1, "session");
    expect(stop).toHaveBeenNthCalledWith(2, "session");
  });

  it("retries cleanup when a stale start cannot be stopped immediately", async () => {
    const firstStart = deferred<string>();
    const startEntered = deferred<void>();
    const calls: string[] = [];
    const backendStart = vi.fn()
      .mockImplementationOnce(() => {
        startEntered.resolve();
        return firstStart.promise;
      })
      .mockImplementationOnce(async (workspace: string) => {
        calls.push(`start:${workspace}`);
        return "current-session";
      });
    const stop = vi.fn()
      .mockImplementationOnce(async (sessionId: string) => {
        calls.push(`stop:${sessionId}`);
        throw new Error("stale cleanup failed");
      })
      .mockImplementation(async (sessionId: string) => {
        calls.push(`stop:${sessionId}`);
      });
    const lifecycle = new TerminalLifecycle({ start: backendStart, stop });

    const stale = lifecycle.start("stale-workspace");
    await startEntered.promise;
    const current = lifecycle.start("current-workspace");
    firstStart.resolve("stale-session");

    await expect(stale).rejects.toThrow("stale cleanup failed");
    await expect(current).resolves.toBe("current-session");
    expect(calls).toEqual([
      "stop:stale-session",
      "stop:stale-session",
      "start:current-workspace",
    ]);
  });
});
