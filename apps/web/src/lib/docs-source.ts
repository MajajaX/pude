import type { DocBlock } from "../i18n-docs";

export type InlinePart = { code: boolean; text: string; raw: string };

/** Split Markdown inline code (`code` or `` code with ` ``) from plain text. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  let last = 0;
  for (const match of text.matchAll(/``\s?(.+?)\s?``|`([^`]+)`/g)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ code: false, text: text.slice(last, index), raw: text.slice(last, index) });
    parts.push({ code: true, text: match[1] ?? match[2], raw: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last), raw: text.slice(last) });
  return parts;
}

const tableRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

/** The Markdown lines a block is written as, ending with a blank separator line. */
export function blockSource(block: DocBlock, releaseAvailable: boolean): string[] {
  switch (block.t) {
    case "h2":
      return [`## ${block.text}`, ""];
    case "h3":
      return [`### ${block.text}`, ""];
    case "p":
      return [block.text, ""];
    case "code":
      return ["```" + block.lang, ...block.code.split("\n"), "```", ""];
    case "list":
      return [...block.items.map((item) => `- ${item}`), ""];
    case "table":
      return [tableRow(block.head), tableRow(block.head.map(() => "---")), ...block.rows.map(tableRow), ""];
    case "note":
      return [`> ${block.text}`, ""];
    case "release-status":
      return [`> ${releaseAvailable ? block.available : block.unavailable}`, ""];
  }
}

/** First source line of each block. Every topic is its own file, so numbering starts at 1. */
export function blockLineNumbers(blocks: DocBlock[], releaseAvailable: boolean): number[] {
  let line = 1;
  return blocks.map((block) => {
    const start = line;
    line += blockSource(block, releaseAvailable).length;
    return start;
  });
}

export type CodeToken = { kind: "kw" | "fn" | "str" | "num" | "com" | "p"; text: string };

const codePatterns = {
  com: { bash: /#.*$/y, js: /\/\/.*$/y } as Record<string, RegExp>,
  str: /"(?:[^"\\]|\\.)*"/y,
  kw: /\b(?:const|let|function|return|if|await|async|void|true|false|null|npm|git|cd|cargo|shasum)\b/y,
  num: /\b\d[\d.]*\b/y,
  fn: /[A-Za-z_$][\w$]*(?=\()/y,
};

function matchAt(pattern: RegExp | undefined, line: string, index: number) {
  if (!pattern) return undefined;
  pattern.lastIndex = index;
  return pattern.exec(line)?.[0];
}

/** A small highlighter covering the bash, JSON and JavaScript samples in the docs. */
export function highlightLine(line: string, lang: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let plain = "";
  let index = 0;
  while (index < line.length) {
    const kinds = [
      ["com", matchAt(codePatterns.com[lang], line, index)],
      ["str", matchAt(codePatterns.str, line, index)],
      ["kw", matchAt(codePatterns.kw, line, index)],
      ["num", matchAt(codePatterns.num, line, index)],
      ["fn", matchAt(codePatterns.fn, line, index)],
    ] as const;
    const found = kinds.find(([, text]) => text);
    const startsWord = index === 0 || !/[\w$]/.test(line[index - 1]);
    if (!found || (found[0] !== "com" && found[0] !== "str" && !startsWord)) {
      plain += line[index];
      index++;
      continue;
    }
    if (plain) tokens.push({ kind: "p", text: plain });
    plain = "";
    tokens.push({ kind: found[0], text: found[1]! });
    index += found[1]!.length;
  }
  if (plain) tokens.push({ kind: "p", text: plain });
  return tokens;
}
