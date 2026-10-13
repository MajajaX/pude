import type { FileChangedEvent } from "../types";

export type WatcherSnapshotToken = {
  epoch: number;
  revision: number;
  sequence: number;
};

export type BufferedWatcherEvents = {
  events: FileChangedEvent[];
  revision: number;
  needsRescan: boolean;
};

export type WatcherEventRecord = {
  accepted: boolean;
  dispatch: boolean;
  revision: number;
  needsRescan: boolean;
};

export type WatcherEventBuffer = {
  beginBuffering: () => void;
  endBuffering: () => BufferedWatcherEvents;
  record: (event: FileChangedEvent) => WatcherEventRecord;
  snapshot: () => WatcherSnapshotToken;
  isCurrent: (token: WatcherSnapshotToken) => boolean;
  markNeedsRescan: () => void;
  resetSequence: () => void;
  clear: () => void;
  isBuffering: () => boolean;
  revision: () => number;
};

const DEFAULT_MAX_BUFFERED_EVENTS = 2048;
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

export function watcherRetryDelay(attempt: number): number {
  if (!Number.isFinite(attempt)) return RETRY_DELAYS_MS[0];
  const boundedAttempt = Math.max(0, Math.floor(attempt));
  return RETRY_DELAYS_MS[Math.min(boundedAttempt, RETRY_DELAYS_MS.length - 1)];
}

export function createWatcherEventBuffer(maxBufferedEvents = DEFAULT_MAX_BUFFERED_EVENTS): WatcherEventBuffer {
  const capacity = Number.isFinite(maxBufferedEvents) ? Math.max(1, Math.floor(maxBufferedEvents)) : DEFAULT_MAX_BUFFERED_EVENTS;
  let buffering = true;
  let epoch = 0;
  let revision = 0;
  let lastSequence = 0;
  let lastSessionId: string | undefined;
  let needsRescan = false;
  let events: FileChangedEvent[] = [];

  const beginBuffering = () => {
    buffering = true;
  };

  const endBuffering = (): BufferedWatcherEvents => {
    buffering = false;
    const pending = { events, revision, needsRescan };
    events = [];
    needsRescan = false;
    return pending;
  };

  const record = (event: FileChangedEvent): WatcherEventRecord => {
    if (event.sessionId && event.sessionId !== lastSessionId) {
      if (lastSessionId !== undefined) needsRescan = true;
      lastSessionId = event.sessionId;
      lastSequence = 0;
    }
    const sequence = event.sequence ?? 0;
    if (sequence > 0 && sequence <= lastSequence) return { accepted: false, dispatch: false, revision, needsRescan: false };
    if (sequence > 0) {
      if (sequence > lastSequence + 1) needsRescan = true;
      lastSequence = sequence;
    }
    revision += 1;
    if (event.needsRescan || Boolean(event.error)) needsRescan = true;
    if (buffering) {
      if (events.length < capacity) events.push(event);
      else needsRescan = true;
      return { accepted: true, dispatch: false, revision, needsRescan };
    }
    const dispatchNeedsRescan = needsRescan;
    needsRescan = false;
    return { accepted: true, dispatch: true, revision, needsRescan: dispatchNeedsRescan };
  };

  const snapshot = (): WatcherSnapshotToken => ({ epoch, revision, sequence: lastSequence });
  const isCurrent = (token: WatcherSnapshotToken) => token.epoch === epoch && token.revision === revision && token.sequence === lastSequence;
  const markNeedsRescan = () => { needsRescan = true; };
  const resetSequence = () => {
    // A watcher restart invalidates any snapshot that is still being read.
    // Keep revision monotonic so a token captured by the previous watcher
    // cannot become current again just because the sequence was reset.
    revision += 1;
    lastSequence = 0;
    lastSessionId = undefined;
  };
  const clear = () => {
    events = [];
    needsRescan = false;
    epoch += 1;
    revision = 0;
    lastSequence = 0;
    lastSessionId = undefined;
  };

  return {
    beginBuffering,
    endBuffering,
    record,
    snapshot,
    isCurrent,
    markNeedsRescan,
    resetSequence,
    clear,
    isBuffering: () => buffering,
    revision: () => revision,
  };
}
