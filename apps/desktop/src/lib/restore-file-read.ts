export { isMissingFileReadError } from "./file-read-errors";

export type RestoreFileReadResult<T> =
  | { status: "available"; file: T }
  | { status: "missing" }
  | { status: "read-failed"; error: unknown };

/** An unreadable file must never become a fabricated empty editable buffer. */
export async function readFileForRestore<T>(
  read: () => Promise<T>,
  isMissing: (error: unknown) => boolean,
): Promise<RestoreFileReadResult<T>> {
  try {
    return { status: "available", file: await read() };
  } catch (error) {
    return isMissing(error) ? { status: "missing" } : { status: "read-failed", error };
  }
}
