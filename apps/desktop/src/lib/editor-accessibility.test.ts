import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { editorContentName } from "./editor-accessibility";

describe("CodeMirror editor accessibility name", () => {
  it("labels the editable content element and reflects the current file name", () => {
    let currentName = "Editing bom.txt";
    const state = EditorState.create({ extensions: [editorContentName(() => currentName)] });
    const [attributeSource] = state.facet(EditorView.contentAttributes);
    const attributes = (attributeSource as (view: EditorView) => Record<string, string>)({} as EditorView);

    expect(attributes["aria-label"]).toBe("Editing bom.txt");

    currentName = "Editing bom-copy.txt";
    const updatedAttributes = (attributeSource as (view: EditorView) => Record<string, string>)({} as EditorView);
    expect(updatedAttributes["aria-label"]).toBe("Editing bom-copy.txt");
  });
});
