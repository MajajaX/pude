import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRUSTED_PYTHON_FOLDERS_STORAGE_KEY,
  TRUSTED_PYTHON_FOLDER_LIMIT,
  changePythonEnvironmentTrust,
  isPythonEnvironmentTrusted,
  isPythonFolderTrusted,
  onPythonEnvironmentTrustChange,
  parseTrustedPythonFolders,
  trustPythonFolder,
  untrustPythonFolder,
} from "./python-environment-trust";

const posix = { platform: "posix", casePolicy: "sensitive" } as const;
const windows = { platform: "windows", casePolicy: "insensitive" } as const;

describe("trusted Python folder list", () => {
  it("adds a folder once and keeps the most recent first", () => {
    let trusted = trustPythonFolder([], "/work/a", posix);
    trusted = trustPythonFolder(trusted, "/work/b", posix);
    trusted = trustPythonFolder(trusted, "/work/a", posix);
    expect(trusted).toEqual(["/work/a", "/work/b"]);
  });

  it("treats trailing separators and Windows spelling of the same folder as one entry", () => {
    expect(trustPythonFolder(trustPythonFolder([], "/work/a/", posix), "/work/a", posix)).toHaveLength(1);
    const trusted = trustPythonFolder([], "C:\\Work\\App\\", windows);
    expect(isPythonFolderTrusted(trusted, "c:/work/app", windows)).toBe(true);
    expect(trustPythonFolder(trusted, "C:/WORK/app", windows)).toHaveLength(1);
  });

  it("keeps different folders and case-sensitive POSIX spellings apart", () => {
    const trusted = trustPythonFolder([], "/work/a", posix);
    expect(isPythonFolderTrusted(trusted, "/work/ab", posix)).toBe(false);
    expect(isPythonFolderTrusted(trusted, "/work/a/sub", posix)).toBe(false);
    expect(isPythonFolderTrusted(trusted, "/work/A", posix)).toBe(false);
    expect(isPythonFolderTrusted(trusted, "/work/a", posix)).toBe(true);
  });

  it("removes only the named folder", () => {
    const trusted = trustPythonFolder(trustPythonFolder([], "/work/a", posix), "/work/b", posix);
    expect(untrustPythonFolder(trusted, "/work/a/", posix)).toEqual(["/work/b"]);
    expect(untrustPythonFolder(trusted, "/work/missing", posix)).toEqual(trusted);
  });

  it("ignores an empty folder", () => {
    expect(trustPythonFolder(["/work/a"], "", posix)).toEqual(["/work/a"]);
    expect(isPythonFolderTrusted(["/work/a"], "", posix)).toBe(false);
  });

  it("drops the oldest entries beyond the cap", () => {
    let trusted: string[] = [];
    for (let index = 0; index < TRUSTED_PYTHON_FOLDER_LIMIT + 5; index += 1) trusted = trustPythonFolder(trusted, `/work/${index}`, posix);
    expect(trusted).toHaveLength(TRUSTED_PYTHON_FOLDER_LIMIT);
    expect(isPythonFolderTrusted(trusted, `/work/${TRUSTED_PYTHON_FOLDER_LIMIT + 4}`, posix)).toBe(true);
    expect(isPythonFolderTrusted(trusted, "/work/0", posix)).toBe(false);
  });

  it("reads stored data defensively", () => {
    expect(parseTrustedPythonFolders(null)).toEqual([]);
    expect(parseTrustedPythonFolders("not json")).toEqual([]);
    expect(parseTrustedPythonFolders("{\"a\":1}")).toEqual([]);
    expect(parseTrustedPythonFolders(JSON.stringify(["/a", 3, "", "/a", "/b"]))).toEqual(["/a", "/b"]);
    const many = Array.from({ length: TRUSTED_PYTHON_FOLDER_LIMIT + 10 }, (_, index) => `/work/${index}`);
    expect(parseTrustedPythonFolders(JSON.stringify(many))).toHaveLength(TRUSTED_PYTHON_FOLDER_LIMIT);
  });
});

describe("changing Python environment trust", () => {
  const stored = new Map<string, string>();
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { stored.set(key, value); },
  };
  afterEach(() => { stored.clear(); vi.unstubAllGlobals(); });

  it("persists the decision, notifies listeners and reports it", () => {
    vi.stubGlobal("localStorage", storage);
    const notify = vi.fn();
    const changed = vi.fn();
    const stopListening = onPythonEnvironmentTrustChange(changed);

    expect(isPythonEnvironmentTrusted("/work/app")).toBe(false);
    changePythonEnvironmentTrust("/work/app", true, notify);
    expect(isPythonEnvironmentTrusted("/work/app")).toBe(true);
    expect(isPythonEnvironmentTrusted("/work/other")).toBe(false);
    expect(changed).toHaveBeenCalledWith("/work/app");
    expect(notify).toHaveBeenLastCalledWith("Trusted the Python environment in app. New terminals will activate it.");

    changePythonEnvironmentTrust("/work/app", false, notify);
    expect(isPythonEnvironmentTrusted("/work/app")).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("Stopped trusting the Python environment in app. New terminals will not activate it.");

    stopListening();
    changePythonEnvironmentTrust("/work/app", true, notify);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("asks for a folder first and reports a failed save without changing anything", () => {
    const notify = vi.fn();
    const changed = vi.fn();
    const stopListening = onPythonEnvironmentTrustChange(changed);

    changePythonEnvironmentTrust(undefined, true, notify);
    expect(notify).toHaveBeenLastCalledWith("Open a folder before changing Python environment trust.");

    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("full"); } });
    changePythonEnvironmentTrust("/work/app", true, notify);
    expect(notify).toHaveBeenLastCalledWith("Python environment trust could not be saved.");
    expect(changed).not.toHaveBeenCalled();
    expect(stored.has(TRUSTED_PYTHON_FOLDERS_STORAGE_KEY)).toBe(false);
    stopListening();
  });
});
