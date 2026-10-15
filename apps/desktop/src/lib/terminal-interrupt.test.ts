import { describe, expect, it } from "vitest";
import { TerminalInterruptRecovery } from "./terminal-interrupt";

describe("terminal interrupt recovery", () => {
  it("recovers an interrupted shell only once, even after repeated Ctrl+C", () => {
    const recovery = new TerminalInterruptRecovery();
    recovery.input("shell", "\u0003");
    recovery.input("shell", "\u0003");
    const exit = { sessionId: "shell", reason: "interrupted" as const };
    expect(recovery.consumeExit(exit)).toBe(true);
    expect(recovery.consumeExit(exit)).toBe(false);
    expect(recovery.consumeExit({ ...exit, sessionId: "new-shell" })).toBe(false);
  });

  it("keeps a normal shell exit and explicit exit after an interrupt ended", () => {
    const recovery = new TerminalInterruptRecovery();
    recovery.input("shell", "\u0003");
    expect(recovery.consumeExit({ sessionId: "shell", reason: "normal" })).toBe(false);
    recovery.input("shell", "\u0003");
    recovery.input("shell", "exit\r");
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
  });

  it("ignores other sessions, errors and exits after disposal or project switching", () => {
    const recovery = new TerminalInterruptRecovery();
    recovery.input("shell", "\u0003");
    expect(recovery.consumeExit({ sessionId: "stale", reason: "interrupted" })).toBe(false);
    expect(recovery.consumeExit({ sessionId: "shell", reason: "error" })).toBe(false);
    recovery.input("shell", "\u0003");
    recovery.reset();
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
    recovery.input("shell", "\u0003", true);
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
  });
});
