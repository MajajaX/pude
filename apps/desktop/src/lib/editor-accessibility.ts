import { EditorView } from "@codemirror/view";

export function editorContentName(name: () => string) {
  return EditorView.contentAttributes.of(() => ({ "aria-label": name() }));
}
