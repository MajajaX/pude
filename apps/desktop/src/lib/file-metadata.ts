export type EditorLanguageKey = "c" | "cpp" | "csharp" | "css" | "go" | "html" | "java" | "javascript" | "json" | "markdown" | "python" | "rust" | "shell" | "sql" | "toml" | "yaml";
export type LanguageIconName = "c" | "cpp" | "csharp" | "java" | "toml" | "ts" | "js" | "py" | "rs" | "html" | "css" | "json" | "md" | "sql" | "sh" | "yaml" | "go";

export type FileLanguageMetadata = {
  key?: EditorLanguageKey;
  label: string;
  icon?: LanguageIconName;
  typescript?: boolean;
  jsx?: boolean;
};

const plainText: FileLanguageMetadata = { label: "Plain Text" };

const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

export function isImagePath(path: string): boolean {
  const extension = path.split(/[\\/.]/).at(-1)?.toLowerCase();
  return imageExtensions.has(extension ?? "");
}

const languageByExtension: Record<string, FileLanguageMetadata> = {
  ts: { key: "javascript", label: "TypeScript", icon: "ts", typescript: true },
  tsx: { key: "javascript", label: "TSX", icon: "ts", typescript: true, jsx: true },
  js: { key: "javascript", label: "JavaScript", icon: "js" },
  jsx: { key: "javascript", label: "JSX", icon: "js", jsx: true },
  mjs: { key: "javascript", label: "JavaScript", icon: "js" },
  cjs: { key: "javascript", label: "JavaScript", icon: "js" },
  json: { key: "json", label: "JSON", icon: "json" },
  jsonc: { key: "json", label: "JSON", icon: "json" },
  md: { key: "markdown", label: "Markdown", icon: "md" },
  markdown: { key: "markdown", label: "Markdown", icon: "md" },
  mdx: { key: "markdown", label: "Markdown", icon: "md" },
  html: { key: "html", label: "HTML", icon: "html" },
  htm: { key: "html", label: "HTML", icon: "html" },
  css: { key: "css", label: "CSS", icon: "css" },
  scss: { key: "css", label: "CSS", icon: "css" },
  py: { key: "python", label: "Python", icon: "py" },
  rs: { key: "rust", label: "Rust", icon: "rs" },
  sql: { key: "sql", label: "SQL", icon: "sql" },
  yaml: { key: "yaml", label: "YAML", icon: "yaml" },
  yml: { key: "yaml", label: "YAML", icon: "yaml" },
  go: { key: "go", label: "Go", icon: "go" },
  java: { key: "java", label: "Java", icon: "java" },
  c: { key: "c", label: "C", icon: "c" },
  h: { key: "c", label: "C", icon: "c" },
  cc: { key: "cpp", label: "C++", icon: "cpp" },
  cpp: { key: "cpp", label: "C++", icon: "cpp" },
  cxx: { key: "cpp", label: "C++", icon: "cpp" },
  hh: { key: "cpp", label: "C++", icon: "cpp" },
  hpp: { key: "cpp", label: "C++", icon: "cpp" },
  hxx: { key: "cpp", label: "C++", icon: "cpp" },
  cs: { key: "csharp", label: "C#", icon: "csharp" },
  csx: { key: "csharp", label: "C#", icon: "csharp" },
  toml: { key: "toml", label: "TOML", icon: "toml" },
  sh: { key: "shell", label: "Shell", icon: "sh" },
  bash: { key: "shell", label: "Shell", icon: "sh" },
  zsh: { key: "shell", label: "Shell", icon: "sh" },
  fish: { key: "shell", label: "Shell", icon: "sh" },
};

export function fileLanguageForPath(path: string): FileLanguageMetadata {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === ".env" || name.startsWith(".env.")) return { key: "shell", label: "Dotenv", icon: "sh" };
  const extension = path.split(/[\\/.]/).at(-1)?.toLowerCase();
  return languageByExtension[extension ?? ""] ?? plainText;
}

export function normalizeDocumentContent(content: string): string {
  return content.includes("\r") ? content.replace(/\r\n?/g, "\n") : content;
}

export type VersionedEditorDocumentSource = {
  content: string;
  lineEndings?: string;
  contentVersion: number;
  normalizedContentVersion?: number;
  savedContent: string;
  savedLineEndings?: string;
  savedRevision: number;
  normalizedSavedRevision?: number;
  lineEnding: "lf" | "crlf";
};

export type NormalizedEditorDocumentSource = {
  content: string;
  lineEndings: string;
  savedContent: string;
  savedLineEndings: string;
  currentWasValidated: boolean;
  savedWasValidated: boolean;
};

/**
 * Resolve a tab's current and saved text at its trust boundary. App/native and
 * recovery loaders mark the versions they have already canonicalized; editor
 * creation can then skip repeating full-content and marker validation scans.
 * Unmarked or stale-version inputs still take the repair path.
 */
export function normalizeEditorDocumentSource(source: VersionedEditorDocumentSource): NormalizedEditorDocumentSource {
  const currentWasValidated = source.normalizedContentVersion === source.contentVersion;
  const content = currentWasValidated ? source.content : normalizeDocumentContent(source.content);
  const lineEndings = currentWasValidated && typeof source.lineEndings === "string"
    ? source.lineEndings
    : normalizeLineEndingMap(content, source.lineEndings, source.lineEnding);

  const savedWasValidated = source.normalizedSavedRevision === source.savedRevision;
  const savedContent = source.savedContent === source.content
    ? content
    : savedWasValidated ? source.savedContent : normalizeDocumentContent(source.savedContent);
  const savedLineEndings = savedContent === content
    ? savedWasValidated && typeof source.savedLineEndings === "string"
      ? source.savedLineEndings
      : normalizeLineEndingMapForLineBreakCount(source.savedLineEndings ?? source.lineEndings, lineEndings.length, source.lineEnding)
    : savedWasValidated && typeof source.savedLineEndings === "string"
      ? source.savedLineEndings
      : normalizeLineEndingMap(savedContent, source.savedLineEndings ?? source.lineEndings, source.lineEnding);

  return { content, lineEndings, savedContent, savedLineEndings, currentWasValidated, savedWasValidated };
}

const LF_MARKER = "l";
const CRLF_MARKER = "c";

function markerForLineEnding(lineEnding: "lf" | "crlf"): string {
  return lineEnding === "crlf" ? CRLF_MARKER : LF_MARKER;
}

/**
 * Return one compact marker for every line separator in normalized content.
 * A marker belongs to the line before that separator; the final unterminated
 * line therefore has no marker.
 */
export function lineEndingMapForContent(content: string, lineEnding: "lf" | "crlf" = "lf"): string {
  return markerForLineEnding(lineEnding).repeat(countNormalizedLineBreaks(content));
}

export function normalizeLineEndingMap(content: string, lineEndings: string | undefined, fallback: "lf" | "crlf" = "lf"): string {
  const expected = countNormalizedLineBreaks(content);
  return normalizeLineEndingMapForLineBreakCount(lineEndings, expected, fallback);
}

export function normalizeLineEndingMapForLineBreakCount(
  lineEndings: string | undefined,
  expected: number,
  fallback: "lf" | "crlf" = "lf",
): string {
  const fallbackMarker = markerForLineEnding(fallback);
  const source = typeof lineEndings === "string" ? lineEndings : "";
  let valid = source.length === expected;
  if (valid) {
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== LF_MARKER && source[index] !== CRLF_MARKER) {
        valid = false;
        break;
      }
    }
  }
  if (valid) return source;

  const normalized = new Array<string>(expected);
  let write = 0;
  for (let index = 0; index < source.length && write < expected; index += 1) {
    const marker = source[index];
    if (marker === LF_MARKER || marker === CRLF_MARKER) normalized[write++] = marker;
  }
  while (write < expected) normalized[write++] = fallbackMarker;
  return normalized.join("");
}

function countNormalizedLineBreaks(content: string): number {
  let count = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") count += 1;
    else if (content[index] === "\r") {
      count += 1;
      if (content[index + 1] === "\n") index += 1;
    }
  }
  return count;
}

export function lineEndingFromMap(lineEndings: string | undefined, fallback: "lf" | "crlf" = "lf"): "lf" | "crlf" {
  if (!lineEndings) return fallback;
  let lf = 0;
  let crlf = 0;
  for (const marker of lineEndings) {
    if (marker === CRLF_MARKER) crlf += 1;
    if (marker === LF_MARKER) lf += 1;
  }
  return crlf > lf ? "crlf" : lf > crlf ? "lf" : fallback;
}

/**
 * Reconcile the separator map after an editor edit. Exact unchanged prefix
 * and suffix lines retain their markers. When lines are inserted or replaced,
 * the new separators inherit the closest preceding mapped line; if there is no
 * preceding line, the closest following mapped line is used. A document with
 * no mapped neighbour falls back to the old file's majority (then the stored
 * preferred ending).
 */
export function reconcileLineEndingMap(
  previousContent: string,
  nextContent: string,
  previousLineEndings: string | undefined,
  preferred: "lf" | "crlf" = "lf",
): string {
  const previous = normalizeDocumentContent(previousContent).split("\n");
  const next = normalizeDocumentContent(nextContent).split("\n");
  const previousMap = normalizeLineEndingMap(previousContent, previousLineEndings, preferred);
  const previousBreaks = Math.max(0, previous.length - 1);
  const nextBreaks = Math.max(0, next.length - 1);
  const fallback = lineEndingFromMap(previousMap, preferred);
  const result: Array<string | undefined> = Array.from({ length: nextBreaks });

  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) suffix += 1;

  for (let index = 0; index < nextBreaks; index += 1) {
    if (index < prefix && index < previousBreaks) {
      result[index] = previousMap[index];
      continue;
    }
    const suffixStart = next.length - suffix;
    if (index >= suffixStart && index < next.length - 1) {
      const previousIndex = previous.length - suffix + (index - suffixStart);
      if (previousIndex >= 0 && previousIndex < previousBreaks) result[index] = previousMap[previousIndex];
    }
  }

  // A same-line-count edit changes text, but not line identity. Preserve its
  // original separator even when the changed line is at the document edge.
  if (previous.length === next.length) {
    for (let index = 0; index < nextBreaks; index += 1) {
      if (result[index] === undefined && index < previousBreaks) result[index] = previousMap[index];
    }
  }

  for (let index = 0; index < nextBreaks; index += 1) {
    if (result[index] !== undefined) continue;
    const preceding = index > 0 ? result[index - 1] : undefined;
    if (preceding !== undefined) {
      result[index] = preceding;
      continue;
    }
    const following = result.slice(index + 1).find((marker) => marker !== undefined);
    result[index] = following ?? markerForLineEnding(fallback);
  }
  return result.join("");
}

/**
 * Serialize normalized editor content to the exact bytes the save backend
 * writes: the UTF-8 BOM when requested, then every "\n" replaced by the
 * separator recorded in the line-ending map (one marker per separator, in
 * order; missing markers reuse the majority ending). A final unterminated
 * line contributes no separator.
 */
export function serializeDocumentBytes(
  content: string,
  lineEndings: string | undefined,
  bom: boolean,
): Uint8Array {
  const majority = lineEndingFromMap(lineEndings, "lf");
  let serialized = "";
  let markerIndex = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== "\n") {
      serialized += character;
      continue;
    }
    const marker = lineEndings && markerIndex < lineEndings.length ? lineEndings[markerIndex] : undefined;
    markerIndex += 1;
    serialized += marker === CRLF_MARKER ? "\r\n" : marker === LF_MARKER ? "\n" : majority === "crlf" ? "\r\n" : "\n";
  }
  const encoder = new TextEncoder();
  const body = encoder.encode(serialized);
  if (!bom) return body;
  const bytes = new Uint8Array(3 + body.length);
  bytes.set([0xef, 0xbb, 0xbf], 0);
  bytes.set(body, 3);
  return bytes;
}

export function sameTextMetadata(
  left: { encoding?: string; bom?: boolean; lineEndings?: string; lineEnding: "lf" | "crlf" },
  right: { encoding?: string; bom?: boolean; lineEndings?: string; lineEnding: "lf" | "crlf" },
  content: string,
): boolean {
  return (left.encoding ?? "utf-8") === (right.encoding ?? "utf-8")
    && Boolean(left.bom) === Boolean(right.bom)
    && normalizeLineEndingMap(content, left.lineEndings, left.lineEnding) === normalizeLineEndingMap(content, right.lineEndings, right.lineEnding);
}
