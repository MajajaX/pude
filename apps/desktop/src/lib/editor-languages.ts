import { LanguageSupport, StreamLanguage } from "@codemirror/language";
import type { EditorLanguageKey, FileLanguageMetadata } from "./file-metadata";

type LanguageLoader = (metadata: FileLanguageMetadata) => Promise<LanguageSupport>;

const languageLoaders: Record<EditorLanguageKey, LanguageLoader> = {
  c: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  csharp: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp)),
  css: async () => (await import("@codemirror/lang-css")).css(),
  go: async () => (await import("@codemirror/lang-go")).go(),
  html: async () => (await import("@codemirror/lang-html")).html(),
  java: async () => (await import("@codemirror/lang-java")).java(),
  javascript: async (metadata) => (await import("@codemirror/lang-javascript")).javascript({ typescript: metadata.typescript, jsx: metadata.jsx }),
  json: async () => (await import("@codemirror/lang-json")).json(),
  markdown: async () => (await import("@codemirror/lang-markdown")).markdown(),
  python: async () => (await import("@codemirror/lang-python")).python(),
  rust: async () => (await import("@codemirror/lang-rust")).rust(),
  shell: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/shell")).shell)),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  toml: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml)),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
};

// LanguageSupport objects contain reusable extension values. Keeping one promise
// per language/options combination avoids loading and constructing the same
// language repeatedly when users switch between cached tabs.
const languageSupportCache = new Map<string, Promise<LanguageSupport>>();

function languageCacheKey(metadata: FileLanguageMetadata): string {
  return `${metadata.key ?? "plain"}:${metadata.typescript ? "ts" : "js"}:${metadata.jsx ? "jsx" : "plain"}`;
}

export function shouldLoadEditorLanguage(metadata: FileLanguageMetadata, largeFile: boolean): boolean {
  return !largeFile && metadata.key !== undefined;
}

export function loadEditorLanguageSupport(metadata: FileLanguageMetadata): Promise<LanguageSupport> {
  if (!metadata.key) return Promise.reject(new Error("Plain text has no language support"));

  const key = languageCacheKey(metadata);
  const cached = languageSupportCache.get(key);
  if (cached) return cached;

  const loading = languageLoaders[metadata.key](metadata);
  languageSupportCache.set(key, loading);
  void loading.catch(() => {
    if (languageSupportCache.get(key) === loading) languageSupportCache.delete(key);
  });
  return loading;
}
