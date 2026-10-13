export type TerminalOutputAckBatch = { upToSeq: number; bytes: number };

/**
 * Completed-but-unacknowledged output is sent back to the Rust reader
 * once it reaches this many bytes, instead of one `terminal_ack_output` invoke
 * per written chunk.
 */
export const TERMINAL_ACK_FLUSH_BYTES = 32 * 1024;

export class TerminalAckQueue {
  private pending: Promise<void> = Promise.resolve();

  reset(): void {
    this.pending = Promise.resolve();
  }

  enqueue(acknowledge: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
    this.pending = this.pending
      .then(acknowledge)
      .catch((error: unknown) => {
        onError(error);
      })
      .catch(() => undefined);
    return this.pending;
  }
}

/**
 * Tracks which sequenced terminal-output chunks the xterm parser has
 * finished writing so the pane can acknowledge them back to the Rust reader.
 * Completion callbacks are recorded per sequence; drainBatch acknowledges the
 * longest contiguous completed run, which both batches acknowledgments and
 * tolerates events arriving slightly out of order.
 */
export class TerminalAckTracker {
  private nextSeq = 1;
  private generation: number | undefined;
  private readonly pending = new Map<number, number>();

  reset(): void {
    this.nextSeq = 1;
    this.generation = undefined;
    this.pending.clear();
  }

  beginGeneration(generation: number): boolean {
    if (this.generation === undefined) {
      this.generation = generation;
      return true;
    }
    return this.generation === generation;
  }

  recordWritten(seq: number, bytes: number, generation?: number): void {
    if (generation !== this.generation || seq < this.nextSeq || bytes < 0) return;
    this.pending.set(seq, bytes);
  }

  /** Bytes whose parser completions are recorded but not yet drained. */
  pendingBytes(): number {
    let bytes = 0;
    for (const value of this.pending.values()) bytes += value;
    return bytes;
  }

  drainBatch(): TerminalOutputAckBatch | undefined {
    let bytes = 0;
    let upToSeq = 0;
    while (this.pending.has(this.nextSeq)) {
      bytes += this.pending.get(this.nextSeq) ?? 0;
      this.pending.delete(this.nextSeq);
      upToSeq = this.nextSeq;
      this.nextSeq += 1;
    }
    return upToSeq > 0 ? { upToSeq, bytes } : undefined;
  }
}

/**
 * Batches the decision of when to send an acknowledgment. Output below
 * `flushBytes` waits for the next animation frame so bursty output collapses
 * into one `terminal_ack_output` per frame; a large backlog flushes
 * immediately so the credit window keeps releasing credit.
 */
export class TerminalAckScheduler {
  private frameHandle: number | undefined;

  constructor(
    private readonly requestFrame: (callback: () => void) => number,
    private readonly cancelFrame: (handle: number) => void,
    private readonly flushBytes: number = TERMINAL_ACK_FLUSH_BYTES,
  ) {}

  /** Runs `flush` now and cancels any frame scheduled earlier. */
  flushNow(flush: () => void): void {
    this.cancelScheduled();
    flush();
  }

  /** Runs `flush` on the next animation frame unless one is already pending. */
  schedule(flush: () => void): void {
    if (this.frameHandle !== undefined) return;
    this.frameHandle = this.requestFrame(() => {
      this.frameHandle = undefined;
      flush();
    });
  }

  cancelScheduled(): void {
    if (this.frameHandle === undefined) return;
    this.cancelFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  reset(): void {
    this.cancelScheduled();
  }
}
