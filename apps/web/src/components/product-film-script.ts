import type { FilmChapter } from "../i18n";

/** Chapter lengths in milliseconds, in playback order. */
export const chapterDurations: Record<FilmChapter, number> = {
  open: 3800,
  edit: 5200,
  save: 3000,
  git: 4800,
  terminal: 5200,
  markdown: 4400,
};

export const chapterOrder: FilmChapter[] = ["open", "edit", "save", "git", "terminal", "markdown"];

export type Token = [kind: "kw" | "fn" | "str" | "num" | "v" | "p", text: string];
export type CodeLine = { tokens: Token[]; added?: boolean };

export const mainTs: CodeLine[] = [
  { tokens: [["kw", "import"], ["p", " { "], ["v", "createSignal"], ["p", " } "], ["kw", "from"], ["p", " "], ["str", "\"solid-js\""], ["p", ";"]] },
  { tokens: [] },
  { tokens: [["kw", "const"], ["p", " ["], ["v", "ready"], ["p", ", "], ["v", "setReady"], ["p", "] = "], ["fn", "createSignal"], ["p", "("], ["num", "false"], ["p", ");"]] },
  { tokens: [] },
  { tokens: [["kw", "export function"], ["p", " "], ["fn", "bootstrap"], ["p", "() {"]] },
  { tokens: [["p", "  "], ["fn", "setReady"], ["p", "("], ["num", "true"], ["p", ");"]] },
  { added: true, tokens: [["p", "  "], ["v", "console"], ["p", "."], ["fn", "log"], ["p", "("], ["str", "\"pude is ready\""], ["p", ", "], ["fn", "ready"], ["p", "());"]] },
  { tokens: [["p", "}"]] },
  { added: true, tokens: [] },
  { added: true, tokens: [["fn", "bootstrap"], ["p", "();"]] },
];

export function lineLength(line: CodeLine) {
  return line.tokens.reduce((total, [, text]) => total + text.length, 0);
}

/** Characters to type, counting one keystroke for each new line. */
export const typedLength = mainTs
  .filter((line) => line.added)
  .reduce((total, line) => total + lineLength(line) + 1, 0);

export function sliceTokens(tokens: Token[], count: number): Token[] {
  const visible: Token[] = [];
  let remaining = count;
  for (const [kind, text] of tokens) {
    if (remaining <= 0) break;
    visible.push([kind, text.slice(0, remaining)]);
    remaining -= text.length;
  }
  return visible;
}

export const terminalCommand = "npm test";

export const terminalOutput = [
  { at: 0.5, kind: "muted", text: "> pude-demo@0.1.0 test" },
  { at: 0.56, kind: "muted", text: "> node --test" },
  { at: 0.68, kind: "ok", text: "✔ bootstrap sets ready (1.8ms)" },
  { at: 0.8, kind: "plain", text: "ℹ tests 1 · pass 1 · fail 0" },
] as const;

export const readmeSource = [
  "# pude-demo",
  "",
  "A tiny workspace for **pude**.",
  "",
  "- Open a folder",
  "- Edit and save",
  "- Review Git",
];
