import { For } from "solid-js";
import { languageNames, t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

const forward = [...languageNames, ...languageNames];
const backward = [...forward].reverse();

export default function Languages() {
  return (
    <section class="langs" use:scroll>
      <div class="wrap" use:reveal>
        <span class="eyebrow">{t().languages.eyebrow}</span>
        <h2 class="section-title langs-title">{t().languages.title}</h2>
      </div>
      <div class="langs-rows" aria-label={languageNames.join(", ")} role="img">
        <div class="langs-row forward">
          <For each={forward}>{(name) => <span>{name}</span>}</For>
        </div>
        <div class="langs-row backward">
          <For each={backward}>{(name) => <span>{name}</span>}</For>
        </div>
      </div>
    </section>
  );
}
