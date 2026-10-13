export type TerminalLifecycleBackend = {
  start: (workspace: string) => Promise<string>;
  stop: (sessionId: string) => Promise<void>;
};

export class TerminalLifecycle {
  private generation = 0;
  private activeSessionId: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly backend: TerminalLifecycleBackend) {}

  start(workspace: string): Promise<string | undefined> {
    const generation = ++this.generation;
    const operation = this.queue.then(async () => {
      await this.stopActiveSession();
      if (generation !== this.generation) return undefined;

      const sessionId = await this.backend.start(workspace);
      if (generation !== this.generation) {
        await this.backend.stop(sessionId);
        return undefined;
      }

      this.activeSessionId = sessionId;
      return sessionId;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  stop(): Promise<void> {
    this.generation += 1;
    const operation = this.queue.then(() => this.stopActiveSession());
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  sessionEnded(sessionId: string): void {
    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
  }

  private async stopActiveSession(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    this.activeSessionId = undefined;
    await this.backend.stop(sessionId);
  }
}
