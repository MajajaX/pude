import { For } from "solid-js";

type WindowAction = "close" | "minimize" | "maximize";

export function WindowControls(props: {
  maximized: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
}) {
  const actions: WindowAction[] = ["minimize", "maximize", "close"];
  const label = (action: WindowAction) => action === "maximize"
    ? props.maximized ? "Restore" : "Maximize"
    : action === "close" ? "Close" : "Minimize";
  const run = (action: WindowAction) => action === "close"
    ? props.onClose() : action === "minimize" ? props.onMinimize() : props.onMaximize();

  return (
    <div class="window-controls" role="group" aria-label="Window controls">
      <For each={actions}>{(action) => (
        <button class={`window-control window-control-${action}`} onClick={() => run(action)} title={label(action)} aria-label={label(action)}>
          <span class={`window-glyph window-glyph-${action}${action === "maximize" && props.maximized ? " window-glyph-restore" : ""}`} />
        </button>
      )}</For>
    </div>
  );
}
