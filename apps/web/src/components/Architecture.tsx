import { For } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

export default function Architecture() {
  return (
    <section id="architecture" class="arch">
      <div class="wrap">
        <div use:reveal>
          <span class="eyebrow">{t().architecture.eyebrow}</span>
          <h2 class="section-title">{t().architecture.title}</h2>
          <p class="section-sub">{t().architecture.sub}</p>
        </div>
        <div class="arch-grid">
          <ol class="arch-stack" use:scroll="enter" style={{ "--n": t().architecture.layers.length }}>
            <span class="arch-wire" aria-hidden="true">
              <span class="arch-packet" />
            </span>
            <For each={t().architecture.layers}>
              {(layer, i) => (
                <li class="arch-layer" style={{ "--i": i() }}>
                  <span class="arch-node" aria-hidden="true" />
                  <div class="arch-layer-body">
                    <h3>{layer.name}</h3>
                    <code>{layer.tech}</code>
                    <p>{layer.detail}</p>
                  </div>
                </li>
              )}
            </For>
          </ol>
          <div class="arch-principles">
            <For each={t().architecture.principles}>
              {(principle, i) => (
                <article class="arch-principle" use:reveal style={{ "--reveal-delay": `${i() * 110}ms` }}>
                  <span class="arch-principle-index">0{i() + 1}</span>
                  <h3>{principle.title}</h3>
                  <p>{principle.desc}</p>
                </article>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  );
}
