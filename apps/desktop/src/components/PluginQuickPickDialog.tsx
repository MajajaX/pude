import { For, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { isImeComposing } from "../lib/keyboard-input";

export type PluginQuickPickItem = { id: string; label: string; description?: string };

const normalize = (value: string) => value.normalize("NFKD").toLocaleLowerCase();

export function PluginQuickPickDialog(props: {
  title: string;
  placeholder?: string;
  items: PluginQuickPickItem[];
  onSelect: (item: PluginQuickPickItem | null) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let input: HTMLInputElement | undefined;
  let dialog: HTMLElement | undefined;
  let list: HTMLDivElement | undefined;
  let modalFocus: ModalFocusController | undefined;
  const optionId = (index: number) => `plugin-quick-pick-option-${index}`;
  const filteredItems = createMemo(() => {
    const needle = normalize(query().trim());
    return needle
      ? props.items.filter((item) => normalize(item.label + " " + (item.description ?? "") + " " + item.id).includes(needle))
      : props.items;
  });

  const selectCurrent = () => {
    const item = filteredItems()[selectedIndex()];
    if (item) props.onSelect(item);
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
      props.onSelect(null);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(0, filteredItems().length - 1)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      selectCurrent();
    }

  };

  createEffect(() => {
    const lastIndex = Math.max(0, filteredItems().length - 1);
    if (selectedIndex() > lastIndex) setSelectedIndex(lastIndex);
  });

  createEffect(() => {
    const selectedOption = list?.querySelector<HTMLElement>(`#${optionId(selectedIndex())}`);
    selectedOption?.scrollIntoView({ block: "nearest" });
  });

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, { initialFocus: () => input });
  });
  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onSelect(null); }}>
      <section ref={(element) => { dialog = element; }} class="command-palette" role="dialog" aria-modal="true" aria-label={props.title} onKeyDown={handleKeyDown}>
        <input
          ref={(element) => { input = element; }}
          class="command-palette-input"
          type="text"
          autocorrect="off"
          autocapitalize="off"
          spellcheck={false}
          role="combobox"
          aria-label={props.placeholder ?? "Filter options"}
          aria-controls="plugin-quick-pick-list"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-activedescendant={filteredItems()[selectedIndex()] ? optionId(selectedIndex()) : undefined}
          value={query()}
          onInput={(event) => { setQuery(event.currentTarget.value); setSelectedIndex(0); }}
          placeholder={props.placeholder ?? "Type to filter…"}
        />
        <div ref={(element) => { list = element; }} id="plugin-quick-pick-list" class="command-palette-list" role="listbox">
          <For each={filteredItems()} fallback={<div class="command-palette-empty">No matching options</div>}>
            {(item, index) => (
              <button
                type="button"
                id={optionId(index())}
                tabIndex={-1}
                role="option"
                aria-selected={selectedIndex() === index()}
                classList={{ "command-palette-item": true, "command-palette-item-selected": selectedIndex() === index() }}
                onMouseEnter={() => setSelectedIndex(index())}
                onClick={() => props.onSelect(item)}
              >
                <span class="command-palette-item-title">{item.label}</span>
                <span class="command-palette-item-detail">{item.description ?? item.id}</span>
              </button>
            )}
          </For>
        </div>
        <footer class="command-palette-footer"><span>↑ ↓ Navigate</span><span>↵ Select</span><span>Esc Cancel</span></footer>
      </section>
    </div>
  );
}
