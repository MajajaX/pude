import assert from "node:assert/strict";
import { test } from "node:test";
import { findPublishedReleaseUrl } from "./build-for-deploy.mjs";

function answer(status, body = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, requests };
}

test("a published release of the version gives its tagged URL", async () => {
  const { fetch, requests } = answer(200, { draft: false });
  assert.equal(
    await findPublishedReleaseUrl("0.1.10", { fetch }),
    "https://github.com/MajajaX/pude/releases/tag/v0.1.10",
  );
  assert.equal(requests[0].url, "https://api.github.com/repos/MajajaX/pude/releases/tags/v0.1.10");
  assert.equal(requests[0].options.headers.Authorization, undefined);
});

test("a version without a release, or with only a draft, builds as a release candidate", async () => {
  assert.equal(await findPublishedReleaseUrl("0.1.11", answer(404)), undefined);
  assert.equal(await findPublishedReleaseUrl("0.1.11", answer(200, { draft: true })), undefined);
});

test("any other answer from GitHub stops the build instead of hiding the downloads", async () => {
  await assert.rejects(findPublishedReleaseUrl("0.1.10", answer(403)), /GitHub answered 403/);
});

test("a token is sent when one is available", async () => {
  const { fetch, requests } = answer(404);
  await findPublishedReleaseUrl("0.1.10", { fetch, token: "test-token" });
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
});
