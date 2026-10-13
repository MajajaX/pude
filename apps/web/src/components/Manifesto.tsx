import { For } from "solid-js";
import { locale, t } from "../i18n";
import { scroll } from "../lib/scroll-progress";

export default function Manifesto() {
  const pieces = () =>
    locale() === "zh-Hant" ? Array.from(t().manifesto.text) : t().manifesto.text.split(" ").map((word) => `${word} `);

  return (
    <section class="manifesto" use:scroll="pin" style={{ "--n": pieces().length }}>
      <div class="manifesto-sticky">
        <div class="wrap">
          <span class="eyebrow">{t().manifesto.eyebrow}</span>
          <p class="manifesto-text">
            <For each={pieces()}>{(piece, i) => <span style={{ "--i": i() }}>{piece}</span>}</For>
          </p>
        </div>
      </div>
    </section>
  );
}
