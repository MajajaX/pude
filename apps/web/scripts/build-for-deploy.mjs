// Builds the website for deployment. It asks GitHub whether the version in package.json
// is published: if it is, the site is built with that release's tagged URL and offers
// downloads; if not, it is built as a release candidate. No release URL is set by hand.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPOSITORY, REPOSITORY_URL } from "../../../shared/repository.mjs";

export async function findPublishedReleaseUrl(version, { fetch = globalThis.fetch, token } = {}) {
  const tag = `v${version}`;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "pude-website-build" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, { headers });
  if (response.status === 404) return undefined;
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} when asked for release ${tag}; try the build again later`);
  }
  const release = await response.json();
  return release.draft === false ? `${REPOSITORY_URL}/releases/tag/${tag}` : undefined;
}

async function main() {
  const webDirectory = fileURLToPath(new URL("..", import.meta.url));
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const releaseUrl = await findPublishedReleaseUrl(version, {
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  console.log(
    releaseUrl
      ? `v${version} is published; building with ${releaseUrl}`
      : `v${version} is not published yet; building it as a release candidate`,
  );

  const env = { ...process.env };
  if (releaseUrl) env.VITE_RELEASE_URL = releaseUrl;
  else delete env.VITE_RELEASE_URL;
  const build = spawnSync("npm", ["run", "build"], {
    cwd: webDirectory,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(build.status ?? 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
