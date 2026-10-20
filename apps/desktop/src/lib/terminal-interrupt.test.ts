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

  it("recovers shells that report a normal or error status after Ctrl+C", () => {
    for (const reason of ["normal", "error", "interrupted", undefined] as const) {
      const recovery = new TerminalInterruptRecovery();
      recovery.input("shell", "\u0003");
      expect(recovery.consumeExit({ sessionId: "shell", reason })).toBe(true);
    }
  });

  it("keeps explicit exits after an interrupt ended", () => {
    const recovery = new TerminalInterruptRecovery();
    expect(recovery.consumeExit({ sessionId: "shell", reason: "normal" })).toBe(false);
    recovery.input("shell", "\u0003");
    recovery.input("shell", "exit\r");
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
    recovery.input("shell", "\u0003");
    recovery.input("shell", "\u001b[200~exit\r\u001b[201~");
    expect(recovery.consumeExit({ sessionId: "shell", reason: "normal" })).toBe(false);
  });

  it("keeps Ctrl+C recovery armed across terminal device replies", () => {
    const recovery = new TerminalInterruptRecovery();
    recovery.input("shell", "\u0003");
    recovery.input("shell", "\u001b[1;1R");
    recovery.input("shell", "\u001b[?1;2c");
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(true);
  });

  it("ignores other sessions and exits after disposal or project switching", () => {
    const recovery = new TerminalInterruptRecovery();
    recovery.input("shell", "\u0003");
    expect(recovery.consumeExit({ sessionId: "stale", reason: "interrupted" })).toBe(false);
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(true);
    recovery.input("shell", "\u0003");
    recovery.reset();
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
    recovery.input("shell", "\u0003", true);
    expect(recovery.consumeExit({ sessionId: "shell", reason: "interrupted" })).toBe(false);
  });
});
