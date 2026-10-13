import { For } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

export default function Shortcuts() {
  return (
    <section id="shortcuts" class="shortcuts">
      <div class="wrap">
        <div use:reveal>
          <span class="eyebrow">{t().shortcuts.eyebrow}</span>
          <h2 class="section-title">{t().shortcuts.title}</h2>
          <p class="section-sub">{t().shortcuts.sub}</p>
        </div>
        <div class="shortcuts-grid" use:scroll="enter" style={{ "--n": t().shortcuts.items.length }}>
          <For each={t().shortcuts.items}>
            {(item, i) => (
              <div class="shortcut" style={{ "--i": i() }}>
                <span class="s-label">{item.label}</span>
                <span class="s-keys">
                  <For each={item.keys}>{(key) => <kbd>{key}</kbd>}</For>
                </span>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
