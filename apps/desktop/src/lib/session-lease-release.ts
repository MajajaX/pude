import type { SessionWindowLease } from "./session-storage";

type ReleaseResult = { ok: boolean; reason?: string };

/** Keep uncertain cleanup separate from leases permitted to write recovery. */
export function createSessionLeaseReleaseQueue(hooks: {
  close: (lease: SessionWindowLease) => Promise<ReleaseResult>;
  onPending: () => void;
  onError: (error: unknown) => void;
}) {
  const pending = new Map<string, SessionWindowLease>();
  const flights = new Map<string, Promise<boolean>>();
  const key = (lease: SessionWindowLease) => JSON.stringify([lease.windowId, lease.scope, lease.leaseId]);
  const retain = (lease: SessionWindowLease) => {
    pending.set(key(lease), lease);
    hooks.onPending();
  };
  const release = (lease: SessionWindowLease): Promise<boolean> => {
    const id = key(lease);
    const current = flights.get(id);
    if (current) return current;
    retain(lease);
    const flight = Promise.resolve().then(async () => {
      try {
        const result = await hooks.close(lease);
        if (result.ok || result.reason === "stale-lease") {
          pending.delete(id);
          return true;
        }
        return false;
      } catch (error) {
        hooks.onError(error);
        return false;
      } finally {
        flights.delete(id);
      }
    });
    flights.set(id, flight);
    return flight;
  };
  const releaseAll = async () => {
    await Promise.all([...pending.values()].map(release));
    return pending.size === 0;
  };
  return { retain, release, releaseAll, hasPending: () => pending.size > 0 };
}
