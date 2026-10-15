import { describe, expect, it } from "vitest";
import { assignMarkdownHeadingIds, markdownHeadingSlug } from "./markdown-heading-ids";

describe("markdown heading ids", () => {
  it("builds lowercase hyphenated slugs and keeps non-latin letters", () => {
    expect(markdownHeadingSlug("Getting Started!")).toBe("getting-started");
    expect(markdownHeadingSlug("使用 教學")).toBe("使用-教學");
    expect(markdownHeadingSlug("!!!")).toBe("section");
  });

  it("keeps repeated headings unique in document order", () => {
    expect(assignMarkdownHeadingIds(["Usage", "Usage", "usage", "Usage 1"])).toEqual(["usage", "usage-1", "usage-2", "usage-1-1"]);
  });
});
