import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { CommandPaletteItem } from "../lib/plugin-activation";
import { BUILTIN_COMMANDS } from "../lib/builtin-commands";
import { formatShortcut, loadRecentCommands, matchesAllWords, orderByRecent, rememberRecentCommand, saveRecentCommands } from "../lib/command-palette-filter";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { isImeComposing } from "../lib/keyboard-input";
import { t } from "../lib/i18n";

export function CommandPalette(props: {
  /** Built-in and plugin commands; only the built-in ones before the plugin host loads. */
  commands?: CommandPaletteItem[];
  mac: boolean;
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
  const recentIds = loadRecentCommands();
  const commands = createMemo(() => orderByRecent(props.commands ?? BUILTIN_COMMANDS, recentIds));
  const filteredCommands = createMemo(() => {
    const needle = query().trim();
    if (!needle) return commands();
    return commands().filter((command) => matchesAllWords(`${t(command.title)} ${command.title} ${command.detail ? t(command.detail) : ""} ${command.detail ?? ""} ${command.id}`, needle));
  });

  const run = (command: CommandPaletteItem) => {
    saveRecentCommands(rememberRecentCommand(recentIds, command.id));
    props.onRun(command);
  };

  const runSelected = () => {
    const command = filteredCommands()[selectedIndex()];
    if (command) run(command);
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
        aria-label={t("Command palette")}
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
          aria-label={t("Search commands")}
          aria-controls="command-palette-list"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={filteredCommands()[selectedIndex()] ? optionId(selectedIndex()) : undefined}
          value={query()}
          onInput={(event) => { setQuery(event.currentTarget.value); setSelectedIndex(0); }}
          placeholder={t("Type a command to search…")}
        />
        <div ref={(element) => { list = element; }} id="command-palette-list" class="command-palette-list" role="listbox">
          <For each={filteredCommands()} fallback={<div class="command-palette-empty">{t("No matching commands")}</div>}>
            {(command, index) => (
              <button
                id={optionId(index())}
                type="button"
                tabIndex={-1}
                role="option"
                aria-selected={selectedIndex() === index()}
                classList={{ "command-palette-item": true, "command-palette-item-selected": selectedIndex() === index() }}
                onMouseEnter={() => setSelectedIndex(index())}
                onClick={() => run(command)}
              >
                <span class="command-palette-item-title">{t(command.title)}</span>
                <span class="command-palette-item-detail">{command.detail ? t(command.detail) : command.source === "plugin" ? t("Plugin command") : t("Built-in command")}</span>
                <Show when={command.shortcut}>{(shortcut) => <kbd class="command-palette-item-shortcut">{formatShortcut(shortcut(), props.mac)}</kbd>}</Show>
              </button>
            )}
          </For>
        </div>
        <footer class="command-palette-footer"><span>{t("↑ ↓ Navigate")}</span><span>{t("↵ Run")}</span><span>{t("Esc Close")}</span></footer>
      </section>
    </div>
  );
}
