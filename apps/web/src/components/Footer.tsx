import { t } from "../i18n";
import { reveal } from "../lib/reveal";
import { scroll } from "../lib/scroll-progress";
import packageInfo from "../../package.json";
import { getAssetDownloadUrl, getPublishedReleaseUrl, getReleaseStage, MACOS_INSTALLER, REPOSITORY_URL } from "../release-info";
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
          <div class="cta-actions">
            {releaseAvailable && releaseUrl ? (
              <a class="btn-primary" href={getAssetDownloadUrl(releaseUrl, MACOS_INSTALLER)}>
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
            <a class="btn-ghost" href={REPOSITORY_URL}>
              {t().cta.github}
            </a>
          </div>
          <p class="cta-note cta-version">
            {t().cta.versionLabel} {packageInfo.version} · {t().cta.stages[releaseStage]}
          </p>
          <p class="cta-note" id={!releaseAvailable ? "download-availability" : undefined}>
            {t().cta.note}
            {!releaseAvailable && <> · {t().cta.unavailable}</>}
          </p>
          {releaseAvailable && releaseUrl && (
            <p class="cta-note">
              <a href={releaseUrl}>{t().cta.allReleases}</a>
            </p>
          )}
        </div>
      </section>
      <footer class="footer">
        <div class="wrap footer-inner">
          <span class="f-tag">
            <BrandMark size={20} />
            {t().footer.tagline}
          </span>
          <span>{t().footer.built}</span>
          <a href={REPOSITORY_URL}>GitHub</a>
        </div>
      </footer>
    </>
  );
}
