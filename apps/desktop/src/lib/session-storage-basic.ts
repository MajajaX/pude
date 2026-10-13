export function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeStorage(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage can be unavailable in private or restricted WebViews.
  }
}
