import type { PluginEditorEdit } from "./plugin-editor-edits";

export type DotenvQuote = "" | "\"" | "'" | "`";

export type DotenvVariable = {
  kind: "variable";
  key: string;
  value: string;
  quote: DotenvQuote;
  /** The value is written across several physical lines inside its quotes. */
  multiline: boolean;
  /** Start of the first line and end of the last line the variable spans. */
  from: number;
  to: number;
  keyFrom: number;
  keyTo: number;
  valueFrom: number;
  valueTo: number;
  duplicate: boolean;
};

export type DotenvNote = { kind: "comment" | "other"; text: string; from: number; to: number };

export type DotenvEntry = DotenvVariable | DotenvNote;

const QUOTES = new Set(["\"", "'", "`"]);

/** Parse dotenv text into variables and comment lines, keeping offsets for editing in place. */
export function parseDotenv(text: string): DotenvEntry[] {
  const entries: DotenvEntry[] = [];
  const seenKeys = new Map<string, DotenvVariable>();
  let lineFrom = 0;
  while (lineFrom <= text.length) {
    const lineTo = lineEnd(text, lineFrom);
    const line = text.slice(lineFrom, lineTo);
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      entries.push({ kind: "comment", text: trimmed.slice(1).trim(), from: lineFrom, to: lineTo });
    } else if (trimmed && !line.includes("=")) {
      entries.push({ kind: "other", text: trimmed, from: lineFrom, to: lineTo });
    } else if (trimmed) {
      const variable = parseVariable(text, lineFrom, lineTo);
      const previous = seenKeys.get(variable.key);
      if (previous) previous.duplicate = variable.duplicate = true;
      seenKeys.set(variable.key, variable);
      entries.push(variable);
      lineFrom = variable.to + 1;
      continue;
    }
    lineFrom = lineTo + 1;
  }
  return entries;
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end < 0 ? text.length : end;
}

function parseVariable(text: string, lineFrom: number, lineTo: number): DotenvVariable {
  const equals = text.indexOf("=", lineFrom);
  const exportPrefix = /^\s*export\s+/.exec(text.slice(lineFrom, equals));
  const keyStart = lineFrom + (exportPrefix?.[0].length ?? 0);
  const rawKey = text.slice(keyStart, equals);
  const keyFrom = keyStart + (rawKey.length - rawKey.trimStart().length);
  const keyTo = equals - (rawKey.length - rawKey.trimEnd().length);

  let valueFrom = equals + 1;
  while (valueFrom < lineTo && (text[valueFrom] === " " || text[valueFrom] === "\t")) valueFrom += 1;
  const variable = { kind: "variable" as const, key: text.slice(keyFrom, keyTo), from: lineFrom, keyFrom, keyTo, valueFrom, multiline: false, duplicate: false };

  const quote = text[valueFrom];
  if (QUOTES.has(quote)) {
    const close = closingQuote(text, valueFrom + 1, quote);
    if (close >= 0) {
      const inner = text.slice(valueFrom + 1, close);
      return { ...variable, quote: quote as DotenvQuote, multiline: inner.includes("\n"), value: quote === "\"" ? unescapeDoubleQuoted(inner) : inner, valueTo: close + 1, to: lineEnd(text, close) };
    }
  }
  const rest = text.slice(valueFrom, lineTo);
  const comment = /(^|\s)#/.exec(rest);
  const value = (comment ? rest.slice(0, comment.index) : rest).trimEnd();
  return { ...variable, quote: "", value, valueTo: valueFrom + value.length, to: lineTo };
}

function closingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (quote === "\"" && text[index] === "\\") index += 1;
    else if (text[index] === quote) return index;
  }
  return -1;
}

const unescapeDoubleQuoted = (value: string) => value.replace(/\\([nr"\\])/g, (_, char: string) => char === "n" ? "\n" : char === "r" ? "\r" : char);

/**
 * Write a value back in the variable's quote style, switching to double quotes when the value needs them.
 * A value that was spread over physical lines keeps its line breaks instead of `\n` escapes.
 */
export function encodeDotenvValue(value: string, quote: DotenvQuote, multiline = false): string {
  if ((quote === "'" || quote === "`") && !value.includes(quote)) return `${quote}${value}${quote}`;
  if (quote === "" && !needsQuotes(value)) return value;
  const escaped = value
    .replace(/\\(?=[nr"\\\r\n]|$)/g, "\\\\")
    .replace(/"/g, "\\\"");
  return `"${multiline ? escaped : escaped.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
}

const needsQuotes = (value: string) => value !== value.trim() || /[\r\n]|\s#|^#|^["'`]/.test(value);

/** Keys cannot contain whitespace or "=", and cannot start with "#". */
export const sanitizeDotenvKey = (key: string) => key.replace(/[\s=]/g, "").replace(/^#+/, "");

export const dotenvKeyEdit = (variable: DotenvVariable, key: string): PluginEditorEdit => ({ from: variable.keyFrom, to: variable.keyTo, insert: sanitizeDotenvKey(key) });

export const dotenvValueEdit = (variable: DotenvVariable, value: string): PluginEditorEdit => ({ from: variable.valueFrom, to: variable.valueTo, insert: encodeDotenvValue(value, variable.quote, variable.multiline) });

/** The `KEY=value` text as written in the file, without an `export` prefix or trailing comment. */
export const dotenvLine = (text: string, variable: DotenvVariable) => text.slice(variable.keyFrom, variable.valueTo);

export function dotenvDeleteEdit(text: string, entry: DotenvEntry): PluginEditorEdit {
  if (entry.to < text.length) return { from: entry.from, to: entry.to + 1, insert: "" };
  return { from: Math.max(0, entry.from - 1), to: entry.to, insert: "" };
}

/** Append a `KEY=value` line at the end of the file; a variable needs a name, so a nameless one adds nothing. */
export function dotenvAppendEdit(text: string, key: string, value: string): PluginEditorEdit | undefined {
  const name = sanitizeDotenvKey(key);
  if (!name) return undefined;
  const line = `${name}=${encodeDotenvValue(value, "")}`;
  const insert = text === "" || text.endsWith("\n") ? `${line}\n` : `\n${line}`;
  return { from: text.length, to: text.length, insert };
}
