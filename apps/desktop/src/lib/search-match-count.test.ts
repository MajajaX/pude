import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import { countSearchMatches } from "./search-match-count";

describe("find bar match count", () => {
  it("counts matches and finds the selected one", () => {
    const state = EditorState.create({ doc: "ab ab ab", selection: EditorSelection.single(3, 5) });
    expect(countSearchMatches(state, new SearchQuery({ search: "ab" }))).toEqual({ current: 2, total: 3, capped: false, invalid: false });
  });

  it("reports zero for an empty query and flags an invalid regular expression", () => {
    const state = EditorState.create({ doc: "abc" });
    expect(countSearchMatches(state, new SearchQuery({ search: "" }))).toMatchObject({ total: 0, invalid: false });
    expect(countSearchMatches(state, new SearchQuery({ search: "(", regexp: true }))).toMatchObject({ total: 0, invalid: true });
  });

  it("stops at the limit and says more matches exist", () => {
    const state = EditorState.create({ doc: "a".repeat(20) });
    expect(countSearchMatches(state, new SearchQuery({ search: "a" }), 5)).toMatchObject({ total: 5, capped: true });
    expect(countSearchMatches(state, new SearchQuery({ search: "a" }), 20)).toMatchObject({ total: 20, capped: false });
  });
});
