import type { EditorState } from "@codemirror/state";
import type { SearchQuery } from "@codemirror/search";

export type SearchMatchCount = { current: number; total: number; capped: boolean; invalid: boolean };

export const SEARCH_MATCH_COUNT_LIMIT = 1000;

/**
 * Count matches of the find bar query and the position of the match at the
 * main selection. Counting stops at the limit so a broad query stays cheap.
 */
export function countSearchMatches(state: EditorState, query: SearchQuery, limit = SEARCH_MATCH_COUNT_LIMIT): SearchMatchCount {
  if (!query.search || !query.valid) return { current: 0, total: 0, capped: false, invalid: Boolean(query.search) && !query.valid };
  const selection = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === selection.from && next.value.to === selection.to) current = total;
    if (total >= limit) return { current, total, capped: !cursor.next().done, invalid: false };
  }
  return { current, total, capped: false, invalid: false };
}
