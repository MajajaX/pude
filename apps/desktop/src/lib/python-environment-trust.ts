import { t } from "./i18n";
import { pathComparisonKey, runtimePathOptions, wireBasename, type PathIdentityOptions } from "./path-identity";
import { readStorage, writeStorage } from "./session-storage-basic";

export const TRUSTED_PYTHON_FOLDERS_STORAGE_KEY = "pude-trusted-python-folders-v1";
export const TRUSTED_PYTHON_FOLDER_LIMIT = 64;

/** Trusted folders are stored as path comparison keys, most recently trusted first. */
export function parseTrustedPythonFolders(raw: string | null): string[] {
  try {
    const stored: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(stored)) return [];
    const keys = stored.filter((key): key is string => typeof key === "string" && key.length > 0);
    return [...new Set(keys)].slice(0, TRUSTED_PYTHON_FOLDER_LIMIT);
  } catch {
    return [];
  }
}

export function trustPythonFolder(trusted: readonly string[], folder: string, options?: PathIdentityOptions): string[] {
  const key = pathComparisonKey(folder, options);
  if (!key) return [...trusted];
  return [key, ...trusted.filter((trustedKey) => trustedKey !== key)].slice(0, TRUSTED_PYTHON_FOLDER_LIMIT);
}

export function untrustPythonFolder(trusted: readonly string[], folder: string, options?: PathIdentityOptions): string[] {
  const key = pathComparisonKey(folder, options);
  return trusted.filter((trustedKey) => trustedKey !== key);
}

export function isPythonFolderTrusted(trusted: readonly string[], folder: string, options?: PathIdentityOptions): boolean {
  const key = pathComparisonKey(folder, options);
  return key.length > 0 && trusted.includes(key);
}

/** Read on every terminal start so a decision made in one window applies to the others. */
export function isPythonEnvironmentTrusted(folder: string): boolean {
  return isPythonFolderTrusted(parseTrustedPythonFolders(readStorage(TRUSTED_PYTHON_FOLDERS_STORAGE_KEY)), folder, runtimePathOptions());
}

const trustChangeListeners = new Set<(folder: string) => void>();

/** Terminals listen so the one the user is looking at restarts with the new decision. */
export function onPythonEnvironmentTrustChange(listener: (folder: string) => void): () => void {
  trustChangeListeners.add(listener);
  return () => trustChangeListeners.delete(listener);
}

export function changePythonEnvironmentTrust(folder: string | undefined, trusted: boolean, notify: (message: string) => void): void {
  if (!folder) {
    notify(t("Open a folder before changing Python environment trust."));
    return;
  }
  const options = runtimePathOptions();
  const current = parseTrustedPythonFolders(readStorage(TRUSTED_PYTHON_FOLDERS_STORAGE_KEY));
  const next = trusted ? trustPythonFolder(current, folder, options) : untrustPythonFolder(current, folder, options);
  if (!writeStorage(TRUSTED_PYTHON_FOLDERS_STORAGE_KEY, JSON.stringify(next))) {
    notify(t("Python environment trust could not be saved."));
    return;
  }
  trustChangeListeners.forEach((listener) => listener(folder));
  const name = wireBasename(folder, options);
  notify(trusted
    ? t("Trusted the Python environment in {name}. New terminals will activate it.", { name })
    : t("Stopped trusting the Python environment in {name}. New terminals will not activate it.", { name }));
}
