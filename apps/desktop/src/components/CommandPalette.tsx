import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { CommandPaletteItem } from "../lib/plugin-activation";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { isImeComposing } from "../lib/keyboard-input";

const normalize = (value: string) => value.normalize("NFKD").toLocaleLowerCase();

export function CommandPalette(props: {
  commands: CommandPaletteItem[];
  onRun: (command: CommandPaletteItem) => void;
  onClose: () => void;
  returnFocus?: () => HTMLElement | undefined;
}) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let dialog: HTMLElement | undefined;
  let list: HTMLDivElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  const optionId = (index: number) => `command-palette-option-${index}`;
  const filteredCommands = createMemo(() => {
    const needle = normalize(query().trim());
    if (!needle) return props.commands;
    return props.commands.filter((command) => normalize(`${command.title} ${command.detail ?? ""} ${command.id}`).includes(needle));
  });

  const runSelected = () => {
    const command = filteredCommands()[selectedIndex()];
    if (command) props.onRun(command);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;
    if (event.key === "Tab") {
      modalFocus.handleKeyDown(event);
      return;
    }
    if (isImeComposing(event)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(0, filteredCommands().length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runSelected();
    }

  };

  createEffect(() => {
    const lastIndex = Math.max(0, filteredCommands().length - 1);
    if (selectedIndex() > lastIndex) setSelectedIndex(lastIndex);
  });

  createEffect(() => {
    const selectedOption = list?.querySelector<HTMLElement>(`#${optionId(selectedIndex())}`);
    selectedOption?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, {
      initialFocus: () => input,
      returnFocus: props.returnFocus,
    });
  });
  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section
        ref={(element) => { dialog = element; }}
        class="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
      >
        <input
          ref={(element) => { input = element; }}
          class="command-palette-input"
          type="text"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          role="combobox"
          aria-label="Search commands"
          aria-controls="command-palette-list"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={filteredCommands()[selectedIndex()] ? optionId(selectedIndex()) : undefined}
          value={query()}
          onInput={(event) => { setQuery(event.currentTarget.value); setSelectedIndex(0); }}
          placeholder="Type a command to search…"
        />
        <div ref={(element) => { list = element; }} id="command-palette-list" class="command-palette-list" role="listbox">
          <For each={filteredCommands()} fallback={<div class="command-palette-empty">No matching commands</div>}>
            {(command, index) => (
              <button
                id={optionId(index())}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={selectedIndex() === index()}
                classList={{ "command-palette-item": true, "command-palette-item-selected": selectedIndex() === index() }}
                onMouseEnter={() => setSelectedIndex(index())}
                onClick={() => props.onRun(command)}
              >
                <span class="command-palette-item-title">{command.title}</span>
                <span class="command-palette-item-detail">{command.detail ?? (command.source === "plugin" ? "Plugin command" : "Built-in command")}</span>
              </button>
            )}
          </For>
        </div>
        <footer class="command-palette-footer"><span>↑ ↓ Navigate</span><span>↵ Run</span><span>Esc Close</span></footer>
      </section>
    </div>
  );
}
