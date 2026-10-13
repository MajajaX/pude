import { For } from "solid-js";
import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";

export default function Philosophy() {
  return (
    <section id="philosophy" class="philosophy">
      <div class="wrap">
        <div use:reveal>
          <span class="eyebrow">{t().philosophy.eyebrow}</span>
          <h2 class="section-title">{t().philosophy.title}</h2>
          <p class="section-sub">{t().philosophy.sub}</p>
        </div>
        <div class="philosophy-cols">
          <div class="phil-card never" use:scroll="enter" style={{ "--n": t().philosophy.wont.length }}>
            <h3>{t().philosophy.wontTitle}</h3>
            <ul>
              <For each={t().philosophy.wont}>
                {(item, i) => (
                  <li style={{ "--i": i() }}>
                    <span class="mark" aria-hidden="true">✕</span>
                    <span class="phil-text">{item}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
          <div class="phil-card always" use:scroll="enter" style={{ "--n": t().philosophy.will.length }}>
            <h3>{t().philosophy.willTitle}</h3>
            <ul>
              <For each={t().philosophy.will}>
                {(item, i) => (
                  <li style={{ "--i": i() }}>
                    <span class="mark" aria-hidden="true">✓</span>
                    <span class="phil-text">{item}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
