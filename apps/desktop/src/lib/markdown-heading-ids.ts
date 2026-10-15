export function markdownHeadingSlug(text: string): string {
  const slug = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
  return slug || "section";
}

/** Gives every heading a stable anchor; repeated titles get -1, -2, … suffixes in document order. */
export function assignMarkdownHeadingIds(headingTexts: readonly string[]): string[] {
  const used = new Set<string>();
  const repeats = new Map<string, number>();
  return headingTexts.map((text) => {
    const base = markdownHeadingSlug(text);
    let id = base;
    while (used.has(id)) {
      const repeat = (repeats.get(base) ?? 0) + 1;
      repeats.set(base, repeat);
      id = `${base}-${repeat}`;
    }
    used.add(id);
    return id;
  });
}
