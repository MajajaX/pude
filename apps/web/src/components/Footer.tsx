import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";
import packageInfo from "../../package.json";
import { getPublishedReleaseUrl, getReleaseStage } from "../release-info";
import BrandMark from "./BrandMark";

const releaseUrl = getPublishedReleaseUrl(import.meta.env.VITE_RELEASE_URL);
const releaseStage = getReleaseStage(packageInfo.version, releaseUrl);
const releaseAvailable = releaseStage === "published";

export default function Footer() {
  return (
    <>
      <section class="cta" id="download" use:scroll="enter">
        <div class="cta-beam" aria-hidden="true">
          <span />
        </div>
        <div class="wrap" use:reveal>
          <h2 class="section-title">{t().cta.title}</h2>
          <p class="section-sub">{t().cta.sub}</p>
          {releaseAvailable && releaseUrl ? (
            <a class="btn-primary" href={releaseUrl}>
              {t().cta.button}
              <span aria-hidden="true">↓</span>
            </a>
          ) : (
            <button
              class="btn-primary"
              type="button"
              disabled
              aria-describedby="download-availability"
              title={t().cta.unavailable}
            >
              {t().cta.button}
              <span aria-hidden="true">↓</span>
            </button>
          )}
          <p class="cta-note cta-version">
            {t().cta.versionLabel} {packageInfo.version} · {t().cta.stages[releaseStage]}
          </p>
          <p class="cta-note" id={!releaseAvailable ? "download-availability" : undefined}>
            {t().cta.note}
            {!releaseAvailable && <> · {t().cta.unavailable}</>}
          </p>
        </div>
      </section>
      <footer class="footer">
        <div class="wrap footer-inner">
          <span class="f-tag">
            <BrandMark size={20} />
            {t().footer.tagline}
          </span>
          <span>{t().footer.built}</span>
        </div>
      </footer>
    </>
  );
}
