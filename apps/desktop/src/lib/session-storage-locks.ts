import { SESSION_REGISTRY_STORAGE_KEY } from "./session-storage-schema";

export const SESSION_GLOBAL_OPERATION_LOCK_KEY = `${SESSION_REGISTRY_STORAGE_KEY}:operation`;

type SessionLockManager = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => T | Promise<T>): Promise<T>;
};

export function getSessionLockManager(): SessionLockManager | null {
  try {
    const candidate = (globalThis as typeof globalThis & { navigator?: { locks?: SessionLockManager } }).navigator?.locks;
    return candidate && typeof candidate.request === "function" ? candidate : null;
  } catch {
    return null;
  }
}

export async function withSessionLock<T>(lockName: string, operation: () => T | Promise<T>): Promise<T | false> {
  const locks = getSessionLockManager();
  if (!locks) return false;
  try {
    return await locks.request(lockName, { mode: "exclusive" }, operation);
  } catch {
    return false;
  }
}

export async function withGlobalSessionLock<T>(operation: (lockHeld: boolean) => T | Promise<T>): Promise<T | false> {
  if (!getSessionLockManager()) return operation(false);
  return withSessionLock(SESSION_GLOBAL_OPERATION_LOCK_KEY, () => operation(true));
}
