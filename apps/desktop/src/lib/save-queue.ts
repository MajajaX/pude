export type SaveExpectation = {
  path: string;
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
};

export type SaveQueueResult = {
  ok: boolean;
  path: string;
  modifiedAt?: number;
  size?: number;
  fingerprint?: string;
};

/**
 * A queued save for the same path must guard against the disk state produced
 * by the preceding successful save. A failed save keeps the original guard so
 * an external edit remains protected on the next attempt.
 */
export function resolveQueuedSaveExpectation(snapshot: SaveExpectation, previous?: SaveQueueResult): SaveExpectation {
  if (previous?.ok && previous.path === snapshot.path) {
    return {
      path: snapshot.path,
      modifiedAt: previous.modifiedAt,
      size: previous.size,
      fingerprint: previous.fingerprint,
    };
  }
  return snapshot;
}
