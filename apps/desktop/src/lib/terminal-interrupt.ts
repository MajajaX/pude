export type TerminalExitPayload = {
  sessionId: string;
  status?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  reason?: "normal" | "interrupted" | "error";
};

export class TerminalInterruptRecovery {
  private interruptedSession: string | undefined;

  input(sessionId: string, data: string, binary = false): void {
    if (binary || /^\u001b\[[?>]?[\d;]*[cRn]$/.test(data)) return;
    this.interruptedSession = data === "\u0003" ? sessionId : undefined;
  }

  consumeExit(payload: TerminalExitPayload): boolean {
    if (this.interruptedSession !== payload.sessionId) return false;
    this.interruptedSession = undefined;
    return true;
  }

  reset(): void { this.interruptedSession = undefined; }
}
