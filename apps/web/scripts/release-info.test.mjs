import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const repository = "https://github.com/MajajaX/pude";
let server;
let releaseInfo;

before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    logLevel: "error",
  });
  releaseInfo = await server.ssrLoadModule("/src/release-info.ts");
});

after(async () => {
  await server.close();
});

test("only the tagged release page of the shown version claims a published release", () => {
  const tagged = `${repository}/releases/tag/v0.1.7`;
  assert.deepEqual(releaseInfo.getSiteRelease(tagged, "0.1.7"), { releaseUrl: tagged, stage: "published" });
});

test("the latest release page cannot prove which version it serves", () => {
  assert.deepEqual(releaseInfo.getSiteRelease(`${repository}/releases/latest`, "0.1.7"), { releaseUrl: undefined, stage: "candidate" });
});

test("a tag for another version, an invalid URL or no URL never claims publication", () => {
  for (const value of [`${repository}/releases/tag/v0.1.6`, "javascript:alert(1)", "", undefined]) {
    assert.deepEqual(releaseInfo.getSiteRelease(value, "0.1.7"), { releaseUrl: undefined, stage: "candidate" });
  }
});

test("a prerelease version stays a development preview", () => {
  const tagged = `${repository}/releases/tag/v0.2.0-rc.1`;
  assert.deepEqual(releaseInfo.getSiteRelease(tagged, "0.2.0-rc.1"), { releaseUrl: tagged, stage: "preview" });
});
