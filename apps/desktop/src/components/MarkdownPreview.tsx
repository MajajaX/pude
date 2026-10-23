import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { assignMarkdownHeadingIds } from "../lib/markdown-heading-ids";
import { t } from "../lib/i18n";

type TableAlignment = "left" | "center" | "right" | undefined;

type InlineToken = {
  kind: "text" | "strong" | "emphasis" | "code" | "link";
  text: string;
  href?: string;
};

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string; tokens: InlineToken[] }
  | { kind: "paragraph"; text: string; tokens: InlineToken[] }
  | { kind: "quote"; text: string; tokens: InlineToken[] }
  | { kind: "list"; ordered: boolean; items: string[]; itemTokens: InlineToken[][] }
  | { kind: "table"; headers: string[]; headerTokens: InlineToken[][]; alignments: TableAlignment[]; rows: string[][]; rowTokens: InlineToken[][][]; truncated: boolean }
  | { kind: "code"; language: string; text: string }
  | { kind: "rule" };

type MarkdownParseResult = {
  blocks: MarkdownBlock[];
  truncated: boolean;
  budget: { rows: number; columns: number; cells: number; inlineTokens: number; domNodes: number };
  documentKey?: string;
};

export const MARKDOWN_PREVIEW_BUDGETS = {
  maxChars: 1 * 1024 * 1024,
  maxLines: 20_000,
  maxBlocks: 2_000,
  maxListItems: 5_000,
  maxInlineTokensPerValue: 256,
  maxInlineTokens: 12_000,
  maxTableRows: 1_000,
  maxTableColumns: 40,
  maxTableCells: 10_000,
  maxTotalTableRows: 2_000,
  maxTotalTableColumns: 256,
  maxTotalTableCells: 5_000,
  maxDomNodes: 50_000,
} as const;

export const MARKDOWN_PREVIEW_SCHEDULE = { debounceMs: 100, maxWaitMs: 300 } as const;
const BLOCK_LOOP_NODE_RESERVE = 1;
const INLINE_TOKEN_NODE_RESERVE = 3;
const PREVIEW_ROOT_NODE_RESERVE = 5;
const TABLE_NOTICE_NODE_RESERVE = 3;

type ParseBudget = {
  rows: number;
  columns: number;
  cells: number;
  inlineTokens: number;
  domNodes: number;
};

type ParsedTable = {
  block?: Extract<MarkdownBlock, { kind: "table" }>;
  endIndex: number;
  truncated: boolean;
  domNodes: number;
};

export function MarkdownPreview(props: {
  documentKey: string;
  revision: number;
  length: number;
  readRange: (from: number, to: number) => string;
}): JSX.Element {
  const [parsed, setParsed] = createSignal<MarkdownParseResult>({
    blocks: [],
    truncated: false,
    budget: { rows: 0, columns: 0, cells: 0, inlineTokens: 0, domNodes: 0 },
  });
  let updateStartedAt: number | undefined;
  let generation = 0;

  createEffect(() => {
    const documentKey = props.documentKey;
    const revision = props.revision;
    const length = props.length;
    const readRange = props.readRange;
    const currentGeneration = ++generation;
    const now = Date.now();
    updateStartedAt ??= now;
    const wait = Math.min(MARKDOWN_PREVIEW_SCHEDULE.debounceMs, Math.max(0, MARKDOWN_PREVIEW_SCHEDULE.maxWaitMs - (now - updateStartedAt)));
    const timer = setTimeout(() => {
      if (currentGeneration !== generation) return;
      const next = parseMarkdownPreviewRange(length, readRange);
      if (currentGeneration !== generation || props.documentKey !== documentKey || props.revision !== revision) return;
      const previous = parsed();
      setParsed({ ...next, documentKey, blocks: previous.documentKey === documentKey ? reuseStableBlocks(previous.blocks, next.blocks) : next.blocks });
      updateStartedAt = undefined;
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });

  onCleanup(() => { generation += 1; });

  const headingIds = createMemo(() => {
    const headings = parsed().blocks.filter((block) => block.kind === "heading");
    const ids = assignMarkdownHeadingIds(headings.map((heading) => heading.tokens.map((token) => token.text).join("")));
    return new Map<MarkdownBlock, string>(headings.map((heading, index) => [heading, ids[index]]));
  });

  const scrollToAnchor = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const href = link?.getAttribute("href");
    if (!href?.startsWith("#")) return;
    event.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const target = event.currentTarget instanceof Element ? event.currentTarget.querySelector(`[id="${CSS.escape(id)}"]`) : null;
    target?.scrollIntoView({ block: "start" });
  };

  return (
    <article class="markdown-preview" aria-label={t("Markdown preview")} on:click={scrollToAnchor}>
      <Show when={parsed().documentKey === props.documentKey && parsed().truncated}>
        <aside class="markdown-preview-notice" role="status" style={{ "margin": "0 auto 20px", "padding": "8px 10px", "color": "var(--muted)", "font-size": "13px", "border": "1px solid var(--border)", "border-radius": "4px", "background": "var(--panel-raised)" }}>
          {t("Preview shortened for performance. It reads at most 1 Mi UTF-16 code units, 20,000 lines, and 2,000 blocks. Each table is capped at 1,000 rows including its header, 40 columns, and 10,000 cells; all tables together are capped at 2,000 rows, 256 columns, and 5,000 cells. Rendered output follows an estimated 50,000-node DOM budget.")}
        </aside>
      </Show>
      <For each={parsed().documentKey === props.documentKey ? parsed().blocks : []}>{(block) => <MarkdownBlockView block={block} headingId={headingIds().get(block)} />}</For>
    </article>
  );
}

function MarkdownBlockView(props: { block: MarkdownBlock; headingId?: string }): JSX.Element {
  const block = props.block;
  if (block.kind === "heading") return <Heading level={block.level} tokens={block.tokens} id={props.headingId} />;
  if (block.kind === "paragraph") return <p><InlineContent tokens={block.tokens} /></p>;
  if (block.kind === "quote") return <blockquote><InlineContent tokens={block.tokens} /></blockquote>;
  if (block.kind === "rule") return <hr />;
  if (block.kind === "code") return <pre><code data-language={block.language || undefined}>{block.text}</code></pre>;
  if (block.kind === "table") return <div class="markdown-table-wrap">
    <Show when={block.truncated}>
      <div class="markdown-preview-notice" role="status" style={{ "margin-bottom": "8px", padding: "8px 10px", color: "var(--muted)", "font-size": "13px", border: "1px solid var(--border)", "border-radius": "4px", background: "var(--panel-raised)" }}>
        {t("Table shortened by preview limits. Showing {rows} data rows and {columns} columns.", { rows: block.rows.length, columns: block.headers.length })}
      </div>
    </Show>
    <table>
      <thead><tr><For each={block.headers}>{(_, index) => <th style={{ "text-align": block.alignments[index()] }}><InlineContent tokens={block.headerTokens[index()] ?? []} /></th>}</For></tr></thead>
      <tbody><For each={block.rows}>{(row, rowIndex) => <tr><For each={row}>{(_, columnIndex) => <td style={{ "text-align": block.alignments[columnIndex()] }}><InlineContent tokens={block.rowTokens[rowIndex()]?.[columnIndex()] ?? []} /></td>}</For></tr>}</For></tbody>
    </table>
  </div>;
  if (block.ordered) return <ol><For each={block.items}>{(_, index) => <li><InlineContent tokens={block.itemTokens[index()]} /></li>}</For></ol>;
  return <ul><For each={block.items}>{(_, index) => <li><InlineContent tokens={block.itemTokens[index()]} /></li>}</For></ul>;
}

function Heading(props: { level: number; tokens: InlineToken[]; id?: string }): JSX.Element {
  if (props.level === 1) return <h1 id={props.id}><InlineContent tokens={props.tokens} /></h1>;
  if (props.level === 2) return <h2 id={props.id}><InlineContent tokens={props.tokens} /></h2>;
  if (props.level === 3) return <h3 id={props.id}><InlineContent tokens={props.tokens} /></h3>;
  if (props.level === 4) return <h4 id={props.id}><InlineContent tokens={props.tokens} /></h4>;
  if (props.level === 5) return <h5 id={props.id}><InlineContent tokens={props.tokens} /></h5>;
  return <h6 id={props.id}><InlineContent tokens={props.tokens} /></h6>;
}

function InlineContent(props: { tokens: InlineToken[] }): JSX.Element {
  return (
    <>
      <For each={props.tokens}>{(token) => {
        if (token.kind === "link") return token.href?.startsWith("#")
          ? <a href={token.href}>{token.text}</a>
          : <a href={token.href} target="_blank" rel="noreferrer">{token.text}</a>;
        if (token.kind === "strong") return <strong>{token.text}</strong>;
        if (token.kind === "emphasis") return <em>{token.text}</em>;
        if (token.kind === "code") return <code>{token.text}</code>;
        return <span>{token.text}</span>;
      }}</For>
    </>
  );
}

export function parseMarkdown(content: string): MarkdownParseResult {
  const limit = Math.min(content.length, MARKDOWN_PREVIEW_BUDGETS.maxChars);
  let source = content.slice(0, limit);
  if (limit < content.length && isHighSurrogate(source.charCodeAt(source.length - 1))) source = source.slice(0, -1);
  return parseMarkdownRange(source.replace(/\r\n?/g, "\n"), content.length > MARKDOWN_PREVIEW_BUDGETS.maxChars);
}

export function parseMarkdownPreviewRange(length: number, readRange: (from: number, to: number) => string): MarkdownParseResult {
  const requestedEnd = Math.min(length, MARKDOWN_PREVIEW_BUDGETS.maxChars);
  let boundedText = readRange(0, requestedEnd).slice(0, requestedEnd);
  if (length > requestedEnd && isHighSurrogate(boundedText.charCodeAt(boundedText.length - 1))) boundedText = boundedText.slice(0, -1);
  return parseMarkdownRange(boundedText, length > MARKDOWN_PREVIEW_BUDGETS.maxChars);
}

function parseMarkdownRange(boundedContent: string, inputTruncated: boolean): MarkdownParseResult {
  const normalized = boundedContent.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n", MARKDOWN_PREVIEW_BUDGETS.maxLines + 1);
  const lineTruncated = lines.length > MARKDOWN_PREVIEW_BUDGETS.maxLines;
  if (lineTruncated) lines.length = MARKDOWN_PREVIEW_BUDGETS.maxLines;
  const blocks: MarkdownBlock[] = [];
  const budget: ParseBudget = { rows: 0, columns: 0, cells: 0, inlineTokens: 0, domNodes: PREVIEW_ROOT_NODE_RESERVE };
  let truncated = inputTruncated || lineTruncated;
  let stopped = false;
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listItemTokens: InlineToken[][] = [];
  let listOrdered = false;
  let listDomNodes = 1 + BLOCK_LOOP_NODE_RESERVE;
  let codeLines: string[] | undefined;
  let codeLanguage = "";

  const pushBlock = (block: MarkdownBlock, domNodes: number): boolean => {
    if (blocks.length >= MARKDOWN_PREVIEW_BUDGETS.maxBlocks || budget.domNodes + domNodes > MARKDOWN_PREVIEW_BUDGETS.maxDomNodes) {
      truncated = true;
      stopped = true;
      return false;
    }
    blocks.push(block);
    budget.domNodes += domNodes;
    return true;
  };

  const pushInlineBlock = (block: MarkdownBlock, tokens: InlineToken[], domNodes: number): boolean => {
    if (pushBlock(block, domNodes)) return true;
    budget.inlineTokens -= tokens.length;
    return false;
  };

  const parseInline = (text: string): InlineToken[] | undefined => {
    const remaining = MARKDOWN_PREVIEW_BUDGETS.maxInlineTokens - budget.inlineTokens;
    if (remaining <= 0) return undefined;
    const tokens = inlineTokens(text, Math.min(MARKDOWN_PREVIEW_BUDGETS.maxInlineTokensPerValue, remaining));
    budget.inlineTokens += tokens.length;
    return tokens;
  };

  const inlineCost = (tokens: InlineToken[]) => BLOCK_LOOP_NODE_RESERVE + tokens.length * INLINE_TOKEN_NODE_RESERVE;
  const flushParagraph = (): boolean => {
    if (!paragraph.length) return true;
    const text = paragraph.join(" ");
    const tokens = parseInline(text);
    paragraph = [];
    if (!tokens) {
      truncated = true;
      stopped = true;
      return false;
    }
    return pushInlineBlock({ kind: "paragraph", text, tokens }, tokens, 1 + inlineCost(tokens));
  };
  const flushList = (): boolean => {
    if (!listItems.length) return true;
    const block = { kind: "list" as const, ordered: listOrdered, items: listItems, itemTokens: listItemTokens };
    const domNodes = listDomNodes;
    const tokenCount = listItemTokens.reduce((total, tokens) => total + tokens.length, 0);
    listItems = [];
    listItemTokens = [];
    listDomNodes = 1 + BLOCK_LOOP_NODE_RESERVE;
    if (pushBlock(block, domNodes)) return true;
    budget.inlineTokens -= tokenCount;
    return false;
  };
  const flushText = (): boolean => flushParagraph() && flushList();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (stopped) break;
    if (codeLines) {
      if (/^\s*```/.test(line)) {
        if (!pushBlock({ kind: "code", language: codeLanguage, text: codeLines.join("\n") }, 4)) break;
        codeLines = undefined;
        codeLanguage = "";
      } else {
        codeLines.push(line);
      }
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w-]*)\s*$/);
    if (fence) {
      if (!flushText()) break;
      codeLines = [];
      codeLanguage = fence[1] ?? "";
      continue;
    }
    if (!line.trim()) {
      if (!flushText()) break;
      continue;
    }

    if (isTableStart(lines, lineIndex)) {
      if (blocks.length >= MARKDOWN_PREVIEW_BUDGETS.maxBlocks) { truncated = true; stopped = true; break; }
      if (!flushText()) break;
      const table = parseTable(lines, lineIndex, budget);
      if (!table?.block) { truncated = true; stopped = true; break; }
      truncated ||= table.truncated;
      if (!pushBlock(table.block, table.domNodes)) break;
      lineIndex = table.endIndex;
      if (table.truncated) {
        stopped = true;
        break;
      }
      continue;
    }

    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (!flushText()) break;
      const text = heading[2];
      const tokens = parseInline(text);
      if (!tokens) { truncated = true; stopped = true; break; }
      if (!pushInlineBlock({ kind: "heading", level: heading[1].length, text, tokens }, tokens, 1 + inlineCost(tokens))) break;
      continue;
    }
    if (/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      if (!flushText() || !pushBlock({ kind: "rule" }, 1 + BLOCK_LOOP_NODE_RESERVE)) break;
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      if (!flushParagraph()) break;
      const nextOrdered = Boolean(ordered);
      if (listItems.length && listOrdered !== nextOrdered && !flushList()) break;
      listOrdered = nextOrdered;
      if (listItems.length >= MARKDOWN_PREVIEW_BUDGETS.maxListItems) {
        truncated = true;
        if (!flushList()) break;
        stopped = true;
        break;
      }
      const text = (unordered ?? ordered)?.[1] ?? "";
      const tokens = parseInline(text);
      if (!tokens) {
        truncated = true;
        if (!flushList()) break;
        stopped = true;
        break;
      }
      const itemCost = 2 + inlineCost(tokens);
      if (budget.domNodes + listDomNodes + itemCost > MARKDOWN_PREVIEW_BUDGETS.maxDomNodes) {
        budget.inlineTokens -= tokens.length;
        truncated = true;
        if (!flushList()) break;
        stopped = true;
        break;
      }
      listItems.push(text);
      listItemTokens.push(tokens);
      listDomNodes += itemCost;
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      if (!flushText()) break;
      const text = quote[1];
      const tokens = parseInline(text);
      if (!tokens) { truncated = true; stopped = true; break; }
      if (!pushInlineBlock({ kind: "quote", text, tokens }, tokens, 1 + inlineCost(tokens))) break;
      continue;
    }

    if (!flushList()) break;
    paragraph.push(line.trim());
  }

  if (!stopped && codeLines) pushBlock({ kind: "code", language: codeLanguage, text: codeLines.join("\n") }, 4);
  if (!stopped) flushText();
  return { blocks, truncated, budget };
}

function isTableStart(lines: string[], startIndex: number): boolean {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine?.includes("|") || !separatorLine?.includes("|")) return false;
  const headers = splitTableRow(headerLine, MARKDOWN_PREVIEW_BUDGETS.maxTableColumns).cells;
  const separator = splitTableRow(separatorLine, MARKDOWN_PREVIEW_BUDGETS.maxTableColumns).cells;
  return headers.length > 0
    && headers.length === separator.length
    && separator.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function parseTable(lines: string[], startIndex: number, budget: ParseBudget): ParsedTable | undefined {
  const headerLine = lines[startIndex];
  const separatorLine = lines[startIndex + 1];
  if (!headerLine?.includes("|") || !separatorLine?.includes("|")) return undefined;

  const maxColumns = Math.min(
    MARKDOWN_PREVIEW_BUDGETS.maxTableColumns,
    MARKDOWN_PREVIEW_BUDGETS.maxTotalTableColumns - budget.columns,
    MARKDOWN_PREVIEW_BUDGETS.maxTotalTableCells - budget.cells,
  );
  if (maxColumns <= 0) return undefined;
  const parsedHeaders = splitTableRow(headerLine, maxColumns);
  const separator = splitTableRow(separatorLine, maxColumns);
  if (!parsedHeaders.cells.length || parsedHeaders.cells.length !== separator.cells.length) return undefined;
  const alignments: TableAlignment[] = [];
  for (const cell of separator.cells) {
    const value = cell.trim();
    if (!/^:?-+:?$/.test(value)) return undefined;
    if (value.startsWith(":") && value.endsWith(":")) alignments.push("center");
    else if (value.endsWith(":")) alignments.push("right");
    else alignments.push(value.startsWith(":") ? "left" : undefined);
  }

  let truncated = parsedHeaders.truncated || separator.truncated;
  const headers = parsedHeaders.cells;
  const headerTokens: InlineToken[][] = [];
  const startingTokenCount = budget.inlineTokens;
  let columns = headers.length;
  for (let index = 0; index < headers.length; index += 1) {
    const tokens = tokenizeInline(headers[index], Math.min(
      MARKDOWN_PREVIEW_BUDGETS.maxInlineTokensPerValue,
      MARKDOWN_PREVIEW_BUDGETS.maxInlineTokens - budget.inlineTokens,
    ));
    if (!tokens) {
      columns = index;
      truncated = true;
      break;
    }
    budget.inlineTokens += tokens.length;
    headerTokens.push(tokens);
  }
  if (columns === 0) {
    budget.inlineTokens = startingTokenCount;
    return undefined;
  }
  if (columns < headers.length) {
    headers.length = columns;
    alignments.length = columns;
    truncated = true;
  }

  const rows: string[][] = [];
  const rowTokens: InlineToken[][][] = [];
  const cellBaseCost = 2 + BLOCK_LOOP_NODE_RESERVE;
  const headerTokenNodes = headerTokens.reduce((total, tokens) => total + tokens.length * INLINE_TOKEN_NODE_RESERVE, 0);
  let tableDomNodes = 6 + TABLE_NOTICE_NODE_RESERVE + columns * cellBaseCost + headerTokenNodes;
  const tableRowLimit = Math.min(MARKDOWN_PREVIEW_BUDGETS.maxTableRows, MARKDOWN_PREVIEW_BUDGETS.maxTotalTableRows - budget.rows);
  const tableCellLimit = Math.min(MARKDOWN_PREVIEW_BUDGETS.maxTableCells, MARKDOWN_PREVIEW_BUDGETS.maxTotalTableCells - budget.cells);
  let tableCells = columns;
  let endIndex = startIndex + 1;

  const canFitHeader = tableRowLimit >= 1
    && tableCellLimit >= columns
    && budget.domNodes + tableDomNodes <= MARKDOWN_PREVIEW_BUDGETS.maxDomNodes;
  if (!canFitHeader) {
    budget.inlineTokens = startingTokenCount;
    return { endIndex, truncated: true, domNodes: 0 };
  }

  const dataRowLimit = tableRowLimit - 1;
  for (let index = startIndex + 2; index < lines.length && rows.length < dataRowLimit; index += 1) {
    const rowLine = lines[index];
    if (!rowLine.trim() || !rowLine.includes("|")) break;
    const parsedRow = splitTableRow(rowLine, columns);
    const cells = columns === parsedRow.cells.length ? parsedRow.cells : [...parsedRow.cells.slice(0, columns)];
    while (cells.length < columns) cells.push("");
    const tokenStart = budget.inlineTokens;
    const tokensForRow: InlineToken[][] = [];
    let rowFits = true;
    for (const cell of cells) {
      const tokens = tokenizeInline(cell, Math.min(
        MARKDOWN_PREVIEW_BUDGETS.maxInlineTokensPerValue,
        MARKDOWN_PREVIEW_BUDGETS.maxInlineTokens - budget.inlineTokens,
      ));
      if (!tokens) {
        rowFits = false;
        break;
      }
      budget.inlineTokens += tokens.length;
      tokensForRow.push(tokens);
    }
    const rowTokenNodes = tokensForRow.reduce((total, tokens) => total + tokens.length * INLINE_TOKEN_NODE_RESERVE, 0);
    const rowDomNodes = 2 + columns * cellBaseCost + rowTokenNodes;
    if (!rowFits || tableCells + columns > tableCellLimit || budget.domNodes + tableDomNodes + rowDomNodes > MARKDOWN_PREVIEW_BUDGETS.maxDomNodes) {
      budget.inlineTokens = tokenStart;
      truncated = true;
      break;
    }
    rows.push(cells);
    rowTokens.push(tokensForRow);
    tableCells += columns;
    tableDomNodes += rowDomNodes;
    endIndex = index;
    if (parsedRow.truncated) {
      truncated = true;
      break;
    }
  }

  if (rows.length >= dataRowLimit && startIndex + 2 + rows.length < lines.length && lines[startIndex + 2 + rows.length]?.includes("|")) truncated = true;
  if (tableCells >= tableCellLimit && endIndex + 1 < lines.length && lines[endIndex + 1]?.includes("|")) truncated = true;
  budget.rows += rows.length + 1;
  budget.columns += columns;
  budget.cells += tableCells;
  return {
    block: { kind: "table", headers, headerTokens, alignments, rows, rowTokens, truncated },
    endIndex,
    truncated,
    domNodes: tableDomNodes,
  };
}

function splitTableRow(line: string, maxColumns: number): { cells: string[]; truncated: boolean } {
  let source = line.trim();
  if (source.startsWith("|")) source = source.slice(1);
  if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  let codeTicks = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") {
      let runLength = 1;
      while (source[index + runLength] === "`") runLength += 1;
      codeTicks = codeTicks === runLength ? 0 : codeTicks || runLength;
      cell += "`".repeat(runLength);
      index += runLength - 1;
      continue;
    }
    if (character === "|" && codeTicks === 0) {
      cells.push(cell.trim());
      cell = "";
      if (cells.length >= maxColumns) return { cells, truncated: true };
      continue;
    }
    cell += character;
  }
  cells.push(cell.trim());
  return { cells, truncated: cells.length > maxColumns };
}

function inlineTokens(text: string, maxTokens: number): InlineToken[] {
  const tokens: InlineToken[] = [];
  const limit = Math.max(1, Math.min(maxTokens, MARKDOWN_PREVIEW_BUDGETS.maxInlineTokensPerValue));
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? cursor;
    const needed = (index > cursor ? 1 : 0) + 1;
    if (tokens.length + needed >= limit && index < text.length) {
      tokens.push({ kind: "text", text: text.slice(cursor) });
      cursor = text.length;
      break;
    }
    if (index > cursor) tokens.push({ kind: "text", text: text.slice(cursor, index) });
    if (match[1] && match[2] && isSafeLink(match[2])) tokens.push({ kind: "link", text: match[1], href: match[2] });
    else if (match[3]) tokens.push({ kind: "code", text: match[3] });
    else if (match[4]) tokens.push({ kind: "strong", text: match[4] });
    else if (match[5]) tokens.push({ kind: "emphasis", text: match[5] });
    else tokens.push({ kind: "text", text: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    if (tokens.length >= limit) {
      const previous = tokens.pop();
      tokens.push({ kind: "text", text: `${previous?.text ?? ""}${text.slice(cursor)}` });
    } else {
      tokens.push({ kind: "text", text: text.slice(cursor) });
    }
  }
  return tokens.length ? tokens : [{ kind: "text", text }];
}

function tokenizeInline(text: string, maxTokens: number): InlineToken[] | undefined {
  if (maxTokens <= 0) return undefined;
  return inlineTokens(text, maxTokens);
}

function isSafeLink(href: string) {
  return href.startsWith("https://") || href.startsWith("http://") || href.startsWith("/") || href.startsWith("#");
}

function isHighSurrogate(codeUnit: number | undefined): boolean {
  return codeUnit !== undefined && codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

export function reuseStableBlocks(previous: MarkdownBlock[], next: MarkdownBlock[]): MarkdownBlock[] {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && sameBlock(previous[prefix], next[prefix])) prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && sameBlock(previous[previous.length - 1 - suffix], next[next.length - 1 - suffix])
  ) suffix += 1;
  if (prefix === 0 && suffix === 0) return next;
  const blocks = next.slice();
  for (let index = 0; index < prefix; index += 1) blocks[index] = previous[index];
  for (let offset = 0; offset < suffix; offset += 1) blocks[blocks.length - 1 - offset] = previous[previous.length - 1 - offset];
  return blocks;
}

function sameBlock(left: MarkdownBlock, right: MarkdownBlock): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "heading" && right.kind === "heading") return left.level === right.level && left.text === right.text;
  if ((left.kind === "paragraph" && right.kind === "paragraph") || (left.kind === "quote" && right.kind === "quote")) return left.text === right.text;
  if (left.kind === "rule" && right.kind === "rule") return true;
  if (left.kind === "code" && right.kind === "code") return left.language === right.language && left.text === right.text;
  if (left.kind === "list" && right.kind === "list") return left.ordered === right.ordered && sameStrings(left.items, right.items);
  if (left.kind === "table" && right.kind === "table") {
    return sameStrings(left.headers, right.headers)
      && sameAlignments(left.alignments, right.alignments)
      && sameRows(left.rows, right.rows)
      && left.truncated === right.truncated;
  }
  return false;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRows(left: string[][], right: string[][]): boolean {
  return left.length === right.length && left.every((row, index) => sameStrings(row, right[index]));
}

function sameAlignments(left: TableAlignment[], right: TableAlignment[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
