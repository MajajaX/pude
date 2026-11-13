import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bundledLicenses } from "./write-bundled-licenses.mjs";

const mitHash = "a".repeat(64);
const apacheHash = `b${"0".repeat(63)}`;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const fullLicenses = `# Third-party license texts

<!-- release-readiness: approved -->

## Scope and verification

- 2026-10-15 review note.

## Locked runtime package inventory

| Target | Package and version | Role | Archive license metadata | Exact source archive and lock digest | Original source file(s) and SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Windows x64, macOS arm64 | **adler2@2.0.1** | app runtime | MIT OR Apache-2.0 | [archive](https://static.crates.io/crates/adler2/adler2-2.0.1.crate); Cargo.lock SHA-256 ${"c".repeat(64)} | LICENSE-MIT → text [${mitHash}](#${mitHash}); SHA-256 ${mitHash}<br>LICENSE-APACHE [https://raw.githubusercontent.com/o/r/${"d".repeat(40)}/LICENSE-APACHE] (source-byte SHA-256 ${apacheHash}) -> text [${apacheHash}](#${apacheHash}) |
| macOS arm64 | **@scope/pkg@1.0.0** | app runtime | MIT | [archive](https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz); npm SRI sha512-abc== | [SPDX License List v3.27.0: MIT](https://example.com/MIT.txt) (source-byte SHA-256 ${mitHash}) -> text [${mitHash}](#${mitHash}) |

## Exact source supplements for archive omissions

| Crate and version | Exact-source basis | Full-text IDs |
| --- | --- | --- |
| adler2@2.0.1 | https://example.com | ${mitHash} |

## Original license and notice text

Each block below contains complete UTF-8 license/notice wording.

<a id="${mitHash}"></a>
### ${mitHash} — source-byte SHA-256 ${mitHash}; LF-normalized fenced-body SHA-256 ${mitHash}
Source: [LICENSE text](https://example.com/mit)

~~~
MIT License
~~~

### ${apacheHash} — source-byte SHA-256 ${apacheHash}; LF-normalized fenced-body SHA-256 ${apacheHash}

\`\`\`text
Apache License
~~~
a line that looks like a fence
~~~
\`\`\`

<a id="${mitHash}"></a>
### ${mitHash} — source-byte SHA-256 ${mitHash}; LF-normalized fenced-body SHA-256 ${mitHash}

\`\`\`text
MIT License
\`\`\`
`;

test("keeps the package-to-license mapping and the license texts, and drops the verification metadata", () => {
  const bundled = bundledLicenses(fullLicenses);
  const mitId = mitHash.slice(0, 12);
  const apacheId = apacheHash.slice(0, 12);
  assert.ok(
    bundled.includes(
      `| Windows x64, macOS arm64 | adler2@2.0.1 | MIT OR Apache-2.0 | LICENSE-MIT → text [${mitId}](#${mitId})<br>LICENSE-APACHE → text [${apacheId}](#${apacheId}) |`,
    ),
  );
  assert.ok(
    bundled.includes(
      `| macOS arm64 | @scope/pkg@1.0.0 | MIT | SPDX License List v3.27.0: MIT → text [${mitId}](#${mitId}) |`,
    ),
  );
  assert.ok(bundled.includes(`<a id="${mitId}"></a>\n### ${mitId}\n\n~~~\nMIT License\n~~~\n`));
  assert.ok(
    bundled.includes(
      `### ${apacheId}\n\n\`\`\`text\nApache License\n~~~\na line that looks like a fence\n~~~\n\`\`\`\n`,
    ),
  );
  for (const dropped of [
    "static.crates.io",
    "registry.npmjs.org",
    "Cargo.lock",
    "sha512",
    "2026-10-15",
    "release-readiness",
  ]) {
    assert.equal(bundled.includes(dropped), false, `${dropped} should not be bundled`);
  }
  assert.equal(bundled.includes(mitHash), false);
  assert.equal(bundled.split(`<a id="${mitId}">`).length, 2, "identical repeated blocks are written once");
});

test("is deterministic and ends with a single newline", () => {
  const bundled = bundledLicenses(fullLicenses);
  assert.equal(bundledLicenses(fullLicenses.replaceAll("\n", "\r\n")), bundled);
  assert.match(bundled, /[^\n]\n$/);
});

test("refuses a record it cannot carry over completely", () => {
  assert.throws(
    () => bundledLicenses(fullLicenses.replace("## Locked runtime package inventory", "## Inventory")),
    /no ## Locked/,
  );
  assert.throws(() => bundledLicenses(fullLicenses.replace("| app runtime |", "|")), /unexpected package row/);
  assert.throws(
    () => bundledLicenses(fullLicenses.replace(`](#${apacheHash})`, `](#${"e".repeat(64)})`)),
    /missing text block/,
  );
  assert.throws(
    () => bundledLicenses(fullLicenses.replace("MIT License\n~~~\n\n###", "MIT License\n\n###")),
    /unclosed fence/,
  );
  assert.throws(
    () => bundledLicenses(fullLicenses.replace("```text\nMIT License\n```", "```text\nChanged wording\n```")),
    /share the ID .* but differ/,
  );
});

/** The wording inside every fenced block of a license record. */
function fencedWordings(markdown) {
  const wordings = [];
  let closingFence;
  let current;
  for (const line of markdown.split("\n")) {
    if (closingFence) {
      if (line === closingFence) {
        wordings.push(`${current.join("\n")}\n`);
        closingFence = undefined;
      } else current.push(line);
      continue;
    }
    const fence = line.match(/^(~{3,}|`{3,})\w*$/);
    if (fence) {
      closingFence = fence[1];
      current = [];
    }
  }
  return wordings;
}

test("the repository record bundles every license text unchanged and every package mapping", async () => {
  const full = await readFile(new URL("../THIRD_PARTY_LICENSES.md", import.meta.url), "utf8");
  const bundled = bundledLicenses(full);

  const verifiedHashes = new Set(
    [...full.matchAll(/LF-normalized fenced-body SHA-256 ([0-9a-f]{64})/g)].map((match) => match[1]),
  );
  const bundledHashes = new Set(fencedWordings(bundled).map(sha256));
  assert.deepEqual([...bundledHashes].sort(), [...verifiedHashes].sort());

  const packages = [...full.matchAll(/^\|[^|\n]*\| \*\*([^*]+)\*\* \|/gm)].map((match) => match[1]);
  assert.ok(packages.length > 400);
  for (const name of packages)
    assert.ok(bundled.includes(`| ${name} |`), `${name} is missing from the bundled mapping`);

  for (const verificationOnly of [
    "Cargo.lock SHA-256",
    "npm SRI",
    "static.crates.io",
    "registry.npmjs.org",
    "Re-verified",
  ]) {
    assert.equal(bundled.includes(verificationOnly), false, `${verificationOnly} should not be bundled`);
  }
  assert.ok(Buffer.byteLength(bundled) < Buffer.byteLength(full) * 0.8);
});
