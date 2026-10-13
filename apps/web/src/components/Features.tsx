import { For } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

function followPointer(event: PointerEvent) {
  const card = event.currentTarget as HTMLElement;
  const box = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${event.clientX - box.left}px`);
  card.style.setProperty("--my", `${event.clientY - box.top}px`);
}

export default function Features() {
  return (
    <section id="features" class="features">
      <div class="wrap">
        <div use:reveal>
          <span class="eyebrow">{t().features.eyebrow}</span>
          <h2 class="section-title">{t().features.title}</h2>
          <p class="section-sub">{t().features.sub}</p>
        </div>
        <div class="bento">
          <For each={t().features.items}>
            {(item, i) => (
              <article class="bento-card" use:scroll="enter" style={{ "--i": i() }} onPointerMove={followPointer}>
                <span class="f-key">{item.k}</span>
                <h3 class="f-title">{item.title}</h3>
                <p class="f-desc">{item.desc}</p>
                <code class="f-meta">{item.meta}</code>
              </article>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}
