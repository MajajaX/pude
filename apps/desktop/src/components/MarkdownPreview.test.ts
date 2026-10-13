import { describe, expect, it } from "vitest";
import { MARKDOWN_PREVIEW_BUDGETS, parseMarkdown, parseMarkdownPreviewRange, reuseStableBlocks } from "./MarkdownPreview";

function tableSource(columns: number, dataRows: number): string {
  const header = Array.from({ length: columns }, (_, index) => `h${index}`);
  const separator = Array.from({ length: columns }, () => "---");
  const row = Array.from({ length: columns }, (_, index) => `v${index}`);
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...Array.from({ length: dataRows }, () => `| ${row.join(" | ")} |`),
  ].join("\n");
}

describe("Markdown preview", () => {
  it("parses GFM cells, alignment, escaped pipes, code-span pipes, and safe links", () => {
    const parsed = parseMarkdown([
      "| Name | Count | Rating | Note | Link |",
      "| :--- | ---: | :---: | --- | --- |",
      "| **Alpha** | 3 | 4.2 | `a|b` | [docs](https://example.com) |",
      "| Beta | 12 | 3 | left \\| pipe | [bad](javascript:alert(1)) |",
    ].join("\n"));

    expect(parsed.truncated).toBe(false);
    expect(parsed.blocks).toHaveLength(1);
    const table = parsed.blocks[0];
    if (table?.kind !== "table") throw new Error("Expected a table");
    expect(table.truncated).toBe(false);
    expect(table.headers).toEqual(["Name", "Count", "Rating", "Note", "Link"]);
    expect(table.alignments).toEqual(["left", "right", "center", undefined, undefined]);
    expect(table.rows).toEqual([
      ["**Alpha**", "3", "4.2", "`a|b`", "[docs](https://example.com)"],
      ["Beta", "12", "3", "left | pipe", "[bad](javascript:alert(1))"],
    ]);
    expect(table.rowTokens[0][4]).toContainEqual({ kind: "link", text: "docs", href: "https://example.com" });
    expect(table.rowTokens[1][4].every((token) => token.kind !== "link")).toBe(true);
    expect(table.rowTokens[1][4].map((token) => token.text).join("")).toBe("[bad](javascript:alert(1))");
  });

  it("reads at most one Mi UTF-16 code units and does not retain a split surrogate pair", () => {
    const content = `${"a".repeat(MARKDOWN_PREVIEW_BUDGETS.maxChars - 1)}😀`;
    const parsed = parseMarkdown(content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.blocks[0]).toMatchObject({ kind: "paragraph" });
    if (parsed.blocks[0]?.kind !== "paragraph") throw new Error("Expected a paragraph");
    expect(parsed.blocks[0].text.length).toBe(MARKDOWN_PREVIEW_BUDGETS.maxChars - 1);
    expect(parsed.blocks[0].text.endsWith("a")).toBe(true);
  });

  it("requests only the bounded prefix for 1, 5, and 20 MiB documents", () => {
    for (const sizeMiB of [1, 5, 20]) {
      let requestedRange: [number, number] | undefined;
      const length = sizeMiB * 1024 * 1024;
      const parsed = parseMarkdownPreviewRange(length, (from, to) => {
        requestedRange = [from, to];
        return "x".repeat(to - from);
      });
      expect(requestedRange).toEqual([0, Math.min(length, MARKDOWN_PREVIEW_BUDGETS.maxChars)]);
      expect(parsed.truncated).toBe(sizeMiB > 1);
      expect(parsed.blocks[0]).toMatchObject({ kind: "paragraph" });
      if (parsed.blocks[0]?.kind !== "paragraph") throw new Error("Expected a paragraph");
      expect(parsed.blocks[0].text.length).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxChars);
    }
  });

  it("normalizes CRLF before joining paragraph lines", () => {
    const parsed = parseMarkdown("first\r\nsecond\rthird");
    expect(parsed.blocks).toMatchObject([{ kind: "paragraph", text: "first second third" }]);
  });

  it("counts header, empty, and data cells in the table budgets", () => {
    const parsed = parseMarkdown(["| Name | Note |", "| --- | --- |", "| | value |"].join("\n"));
    const table = parsed.blocks[0];
    if (table?.kind !== "table") throw new Error("Expected a table");
    expect(table.headers).toEqual(["Name", "Note"]);
    expect(table.rows).toEqual([["", "value"]]);
    expect(parsed.budget).toMatchObject({ rows: 2, columns: 2, cells: 4 });
  });

  it("caps a 19,000-row, two-column table and reports omitted rows", () => {
    const parsed = parseMarkdown(tableSource(2, 19_000));
    expect(parsed.truncated).toBe(true);
    expect(parsed.blocks).toHaveLength(1);
    const table = parsed.blocks[0];
    if (table?.kind !== "table") throw new Error("Expected a table");
    expect(table.rows).toHaveLength(MARKDOWN_PREVIEW_BUDGETS.maxTableRows - 1);
    expect(table.truncated).toBe(true);
    expect(parsed.budget).toMatchObject({ rows: 1_000, columns: 2, cells: 2_000 });
    expect(parsed.budget.domNodes).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxDomNodes);
  });

  it("caps a very wide table and accurately marks omitted columns", () => {
    const parsed = parseMarkdown(tableSource(100, 2));
    const table = parsed.blocks[0];
    expect(parsed.truncated).toBe(true);
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") throw new Error("Expected a table");
    expect(table.headers).toHaveLength(MARKDOWN_PREVIEW_BUDGETS.maxTableColumns);
    expect(table.truncated).toBe(true);
    expect(table.rows[0]).toHaveLength(MARKDOWN_PREVIEW_BUDGETS.maxTableColumns);
    expect(parsed.budget).toMatchObject({ rows: 2, columns: 40, cells: 80 });
  });

  it("applies the aggregate cell budget across tables", () => {
    const content = `${tableSource(8, 500)}\n\n${tableSource(8, 300)}`;
    const parsed = parseMarkdown(content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.budget.cells).toBe(MARKDOWN_PREVIEW_BUDGETS.maxTotalTableCells);
    expect(parsed.budget.rows).toBeLessThan(MARKDOWN_PREVIEW_BUDGETS.maxTotalTableRows);
    expect(parsed.budget.domNodes).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxDomNodes);
  });

  it("applies the aggregate column budget across many tables", () => {
    const content = Array.from({ length: 8 }, () => tableSource(40, 0)).join("\n\n");
    const parsed = parseMarkdown(content);
    expect(parsed.truncated).toBe(true);
    expect(parsed.budget.columns).toBe(MARKDOWN_PREVIEW_BUDGETS.maxTotalTableColumns);
    expect(parsed.budget.domNodes).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxDomNodes);
  });

  it("keeps inline tokens and rendered-node cost within the global budget", () => {
    const linkedCell = "[word](https://example.com)".repeat(300);
    const content = [
      "| left | right |",
      "| --- | --- |",
      ...Array.from({ length: 100 }, () => `| ${linkedCell} | ${linkedCell} |`),
    ].join("\n");
    const parsed = parseMarkdown(content);
    expect(parsed.budget.inlineTokens).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxInlineTokens);
    expect(parsed.budget.domNodes).toBeLessThanOrEqual(MARKDOWN_PREVIEW_BUDGETS.maxDomNodes);
  });

  it("reuses unaffected blocks before and after an edited block", () => {
    const previous = parseMarkdown("first\n\nold middle\n\nlast").blocks;
    const next = parseMarkdown("first\n\nnew middle\n\nlast").blocks;
    const reused = reuseStableBlocks(previous, next);
    expect(reused[0]).toBe(previous[0]);
    expect(reused[1]).toBe(next[1]);
    expect(reused[2]).toBe(previous[2]);
  });
});
