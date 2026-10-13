/**
 * Path identity helpers deliberately keep four concepts separate:
 *
 * - `displayPath` is the spelling shown to the user.
 * - `wirePath` is the exact spelling passed over the app/native boundary.
 * - `comparisonKey` is a conservative lexical key for in-memory identity only.
 * - A filesystem-canonical target requires an OS `realpath`/identity lookup;
 *   this pure module never resolves dot segments or symlinks.
 *
 * Comparison keys normalize only separators that are structural for the
 * selected platform and insignificant trailing separators. They do not trim
 * whitespace, normalize Unicode, resolve `.`/`..`, or follow symlinks. The
 * default case policy is sensitive on every platform because case behavior is
 * a volume property (and Windows can enable per-directory case sensitivity).
 *
 * Use the original `wirePath` for filesystem operations. Never send a
 * comparison key to the filesystem.
 */

export type PathPlatform = "posix" | "windows";
export type PathCasePolicy = "sensitive" | "insensitive";
export type PathIdentityKind =
  | "empty"
  | "uri"
  | "posix"
  | "windows-drive-absolute"
  | "windows-drive-relative"
  | "windows-unc"
  | "windows-verbatim"
  | "windows-rooted"
  | "windows-relative";

export type PathIdentityOptions = {
  platform?: PathPlatform;
  /** Opt into this only when the target volume's case-insensitive behavior is known. */
  casePolicy?: PathCasePolicy;
};

export type PathIdentity = {
  displayPath: string;
  wirePath: string;
  comparisonKey: string;
  kind: PathIdentityKind;
  platform: PathPlatform;
  casePolicy: PathCasePolicy;
};

const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const URI_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

export function runtimePathPlatform(): PathPlatform {
  if (typeof navigator !== "undefined") {
    const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
    if (/Win/i.test(platform)) return "windows";
    if (/Mac|iPhone|iPad/i.test(platform)) return "posix";
    if (/Linux|X11|Unix/i.test(platform)) return "posix";
  }
  return "posix";
}

/**
 * Compatibility policy used by existing desktop path consumers: POSIX paths
 * remain case-sensitive; Windows path identity keeps its historic
 * case-insensitive comparison. This is an app policy, not a claim that every
 * Windows volume is case-insensitive. Callers with volume metadata should
 * pass an explicit `PathIdentityOptions` policy instead.
 */
export function runtimePathOptions(): PathIdentityOptions {
  const platform = runtimePathPlatform();
  return { platform, casePolicy: platform === "windows" ? "insensitive" : "sensitive" };
}

export function createPathIdentity(path: string, options: PathIdentityOptions = {}): PathIdentity {
  const platform = options.platform ?? runtimePathPlatform();
  const casePolicy = options.casePolicy ?? "sensitive";
  const { comparisonKey, kind } = platform === "windows"
    ? windowsPathKey(path)
    : posixPathKey(path);

  return {
    displayPath: path,
    wirePath: path,
    comparisonKey: casePolicy === "insensitive" ? comparisonKey.toLowerCase() : comparisonKey,
    kind,
    platform,
    casePolicy,
  };
}

export function pathComparisonKey(path: string, options: PathIdentityOptions = {}): string {
  return createPathIdentity(path, options).comparisonKey;
}

export function samePath(left: string, right: string, options: PathIdentityOptions = {}): boolean {
  return pathComparisonKey(left, options) === pathComparisonKey(right, options);
}

export function isSameOrDescendantPath(path: string, parent: string, options: PathIdentityOptions = {}): boolean {
  const platform = options.platform ?? runtimePathPlatform();
  const candidate = pathComparisonKey(path, { ...options, platform });
  const root = pathComparisonKey(parent, { ...options, platform });
  if (!root || !candidate) return false;
  // Do not infer containment through lexical traversal. Following symlinks and
  // proving an actual filesystem target still requires the native filesystem.
  if (hasDotSegment(candidate, platform) || hasDotSegment(root, platform)) return false;
  if (candidate === root) return true;

  // `C:` is the current directory on drive C, so `C:child` is relative to it;
  // `C:/child` is rooted and must remain a different path form.
  if (platform === "windows" && /^[A-Za-z]:$/.test(root)) {
    return candidate.startsWith(root) && candidate.length > root.length && candidate[root.length] !== "/";
  }

  const separator = "/";
  if (isFilesystemRoot(parent, platform)) return candidate.startsWith(root.endsWith(separator) ? root : `${root}${separator}`);
  return candidate.startsWith(`${root}${separator}`);
}

/** Join a relative wire path to a root without changing either input path. */
export function joinWirePath(root: string, relative: string, options: PathIdentityOptions = {}): string {
  if (!relative) return root;
  const platform = options.platform ?? runtimePathPlatform();
  if (isAbsoluteOrRootedPath(relative, platform)) return relative;

  const windows = platform === "windows";
  const separator = windows && root.includes("\\") ? "\\" : "/";
  const relativeWithNativeSeparators = windows ? relative.replaceAll("/", separator) : relative;
  if (windows && /^[A-Za-z]:$/.test(root)) return `${root}${relativeWithNativeSeparators}`;
  if (!windows && /^\/+$/u.test(root)) return `${root}${relativeWithNativeSeparators}`;
  const rootWithoutTrailingSeparators = windows
    ? root.replace(/[\\/]+$/, "")
    : root.replace(/\/+$/, "");
  if (!rootWithoutTrailingSeparators) return `${separator}${relativeWithNativeSeparators}`;
  return `${rootWithoutTrailingSeparators}${separator}${relativeWithNativeSeparators}`;
}

/** Return the final path component without reinterpreting separators from another platform. */
export function wireBasename(path: string, options: PathIdentityOptions = {}): string {
  if (!path) return path;
  const platform = options.platform ?? runtimePathPlatform();
  const withoutTrailingSeparators = platform === "windows"
    ? path.replace(/[\\/]+$/u, "")
    : path.replace(/\/+$/u, "");
  if (!withoutTrailingSeparators) return path;

  const separatorIndex = lastWireSeparatorIndex(withoutTrailingSeparators, platform);
  if (separatorIndex < 0) return withoutTrailingSeparators;
  return withoutTrailingSeparators.slice(separatorIndex + 1) || withoutTrailingSeparators;
}

/** Return the lexical parent while preserving the path's wire separators and root spelling. */
export function wireParentPath(path: string, options: PathIdentityOptions = {}): string {
  if (!path) return ".";
  const platform = options.platform ?? runtimePathPlatform();
  if (platform === "posix" && /^\/+$/u.test(path)) return path;
  if (platform === "windows" && (isWindowsDriveRoot(path) || /^[\\/]+$/u.test(path) || isFilesystemRoot(path, platform))) {
    return path;
  }

  const withoutTrailingSeparators = platform === "windows"
    ? path.replace(/[\\/]+$/u, "")
    : path.replace(/\/+$/u, "");
  const separatorIndex = lastWireSeparatorIndex(withoutTrailingSeparators, platform);
  if (separatorIndex < 0) {
    if (platform === "windows") {
      const drive = withoutTrailingSeparators.match(DRIVE_PREFIX)?.[0];
      if (drive) return drive;
    }
    return ".";
  }

  const leadingSeparators = withoutTrailingSeparators.match(platform === "windows" ? /^[\\/]+/u : /^\/+/u)?.[0] ?? "";
  if (separatorIndex < leadingSeparators.length) return leadingSeparators;

  const parent = withoutTrailingSeparators.slice(0, separatorIndex);
  if (platform === "windows" && /^(?:\\\\\?\\)?[A-Za-z]:$/.test(parent)) {
    return `${parent}${withoutTrailingSeparators[separatorIndex]}`;
  }
  return parent || withoutTrailingSeparators[separatorIndex];
}

function windowsPathKey(path: string): { comparisonKey: string; kind: PathIdentityKind } {
  if (!path) return { comparisonKey: "", kind: "empty" };
  if (URI_PREFIX.test(path) && !DRIVE_PREFIX.test(path)) return { comparisonKey: path, kind: "uri" };
  if (path.startsWith("\\\\?\\")) {
    const tail = path.slice(4);
    const ordinary = /^[A-Za-z]:\\/.test(tail) ? tail : /^UNC\\/i.test(tail) ? `\\\\${tail.slice(4)}` : undefined;
    const components = ordinary?.replace(/^[A-Za-z]:\\|^\\\\/, "").split("\\");
    const unambiguous = ordinary && components && components.length >= (DRIVE_ABSOLUTE.test(ordinary) ? 1 : 2) && components.every((component, index) =>
      (!component && index === components.length - 1)
      || (Boolean(component) && !/[. ]$|[/:<>"|?*]/.test(component)
        && !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(component)));
    return ordinary && unambiguous ? windowsPathKey(ordinary) : { comparisonKey: path, kind: "windows-verbatim" };
  }

  if (DRIVE_PREFIX.test(path)) {
    const drive = path.slice(0, 2);
    const tail = path.slice(2);
    if (!tail || !/^[\\/]/.test(tail)) {
      const normalizedTail = tail.replaceAll("\\", "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
      return { comparisonKey: `${drive}${normalizedTail}`, kind: "windows-drive-relative" };
    }
    let normalizedTail = tail.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    if (normalizedTail !== "/") normalizedTail = normalizedTail.replace(/\/+$/, "");
    return { comparisonKey: `${drive}${normalizedTail}`, kind: "windows-drive-absolute" };
  }

  if (/^[\\/]{2}/.test(path)) {
    const normalized = `//${path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/")}`;
    const trimmed = normalized === "//" ? normalized : normalized.replace(/\/+$/, "");
    return { comparisonKey: trimmed, kind: "windows-unc" };
  }

  if (/^[\\/]/.test(path)) {
    let normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
    if (normalized !== "/") normalized = normalized.replace(/\/+$/, "");
    return { comparisonKey: normalized, kind: "windows-rooted" };
  }

  let normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  normalized = normalized.replace(/\/+$/, "");
  return { comparisonKey: normalized, kind: "windows-relative" };
}

function posixPathKey(path: string): { comparisonKey: string; kind: PathIdentityKind } {
  if (!path) return { comparisonKey: "", kind: "empty" };
  if (URI_PREFIX.test(path) && !DRIVE_PREFIX.test(path)) return { comparisonKey: path, kind: "uri" };

  // POSIX permits an implementation-defined meaning for exactly two leading
  // slashes, so preserve the leading run instead of merging it with `/`.
  const leadingSlashCount = path.match(/^\/+$/)?.[0].length;
  if (leadingSlashCount) return { comparisonKey: "/".repeat(leadingSlashCount), kind: "posix" };
  const leading = path.match(/^\/+/u)?.[0] ?? "";
  const body = path.slice(leading.length).replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return { comparisonKey: `${leading}${body}`, kind: "posix" };
}

function isFilesystemRoot(path: string, platform: PathPlatform): boolean {
  if (platform === "posix") return /^\/+$/u.test(path);

  const key = windowsPathKey(path).comparisonKey;
  if (key === "/") return true;
  if (/^[A-Za-z]:\/$/.test(key)) return true;
  // A UNC server/share pair without a trailing separator is its own root.
  const unc = key.match(/^\/\/([^/]+)\/([^/]+)$/);
  return Boolean(unc);
}

function isAbsoluteOrRootedPath(path: string, platform: PathPlatform): boolean {
  if (platform === "posix") return path.startsWith("/");
  return DRIVE_PREFIX.test(path) || DRIVE_ABSOLUTE.test(path) || /^[\\/]{2}/.test(path) || /^[\\/]/.test(path);
}

function hasDotSegment(path: string, platform: PathPlatform): boolean {
  return path.split(platform === "windows" ? /[\\/]/ : /\//).some((segment) => segment === "." || segment === "..");
}

function lastWireSeparatorIndex(path: string, platform: PathPlatform): number {
  const slash = path.lastIndexOf("/");
  if (platform === "posix") return slash;
  return Math.max(slash, path.lastIndexOf("\\"));
}

function isWindowsDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]+$/u.test(path);
}
