// Writes the license file that ships inside the app from the complete
// THIRD_PARTY_LICENSES.md: every license text and the package-to-license mapping stay,
// while the verification metadata (archive URLs, lock digests, dated review notes,
// upstream commit URLs) is left to the repository and the release assets.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fullFile = resolve(root, "THIRD_PARTY_LICENSES.md");
const bundledFile = resolve(root, "apps/desktop/src-tauri/gen/THIRD_PARTY_LICENSES.md");

const inventoryHeading = "## Locked runtime package inventory";
const supplementsHeading = "## Exact source supplements for archive omissions";
const textsHeading = "## Original license and notice text";
const idLength = 12;

const preface = `# Third-party license texts

This file contains the license and notice texts of the third-party packages in the pude app runtime, and shows which license text applies to which package. The first table lists each package version with its license expression and the text blocks that carry its license wording; the blocks follow the table. Packages that are listed once per platform are marked with the platforms that include them.

The complete inventory, with archive URLs, lock digests, source hashes and review notes, is THIRD_PARTY_LICENSES.md in the pude repository (https://github.com/MajajaX/pude) and an asset of each GitHub release. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships next to this file, lists the direct dependencies.
`;

function sectionLines(lines, heading, nextHeading) {
  const start = lines.indexOf(heading);
  const end = nextHeading ? lines.indexOf(nextHeading) : lines.length;
  if (start === -1 || end === -1 || end < start) throw new Error(`THIRD_PARTY_LICENSES.md has no ${heading} section`);
  return lines.slice(start + 1, end);
}

const shortId = (hash) => hash.slice(0, idLength);

/** Keeps the license and text IDs of one inventory cell: no URLs, digests or source hashes. */
function licenseTexts(cell) {
  return cell
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/ \[https?:\/\/[^\]]+\] \(source-byte SHA-256 [0-9a-f]{64}\)/g, "")
    .replace(/; SHA-256 [0-9a-f]{64}/g, "")
    .replace(/ \(source-byte SHA-256 [0-9a-f]{64}\)/g, "")
    .replace(/ ->/g, " →")
    .replace(/\[([0-9a-f]{64})\]\(#([0-9a-f]{64})\)/g, (_, text, anchor) => `[${shortId(text)}](#${shortId(anchor)})`)
    .trim();
}

function packageRow(row) {
  const cells = row
    .slice(1, -1)
    .split(" | ")
    .map((cell) => cell.trim());
  if (cells.length !== 6) throw new Error(`unexpected package row: ${row.slice(0, 120)}`);
  const [targets, name, , license, , texts] = cells;
  return `| ${targets} | ${name.replaceAll("**", "")} | ${license} | ${licenseTexts(texts)} |`;
}

/** Each text block is a heading followed by the fenced license wording; the lines between are source notes. */
function parseTextBlocks(lines) {
  const blocks = [];
  let closingFence;
  for (const line of lines) {
    const current = blocks.at(-1);
    if (closingFence) {
      current.text.push(line);
      if (line === closingFence) closingFence = undefined;
      continue;
    }
    const heading = line.match(/^### ([0-9a-f]{64}) — /);
    if (heading) {
      blocks.push({ hash: heading[1], text: [] });
      continue;
    }
    const fence = line.match(/^(~{3,}|`{3,})\w*$/);
    if (fence && current) {
      closingFence = fence[1];
      current.text.push(line);
    }
  }
  if (closingFence) throw new Error(`text block ${blocks.at(-1).hash} has an unclosed fence`);
  const empty = blocks.find((block) => block.text.length === 0);
  if (empty) throw new Error(`text block ${empty.hash} has no license text`);
  return blocks;
}

const fencedWording = (text) => text.slice(1, -1).join("\n");

/** Each block is titled by the shortened hash its table rows link to. Repeated identical blocks are written once. */
function textBlocks(lines) {
  const output = [];
  const blocksById = new Map();
  for (const { hash, text } of parseTextBlocks(lines)) {
    const id = shortId(hash);
    const known = blocksById.get(id);
    if (!known) {
      blocksById.set(id, { hash, text });
      output.push(`<a id="${id}"></a>`, `### ${id}`, "", ...text, "");
    } else if (known.hash !== hash || fencedWording(known.text) !== fencedWording(text)) {
      throw new Error(`text blocks ${hash} and ${known.hash} share the ID ${id} but differ`);
    }
  }
  return { lines: output, ids: new Set(blocksById.keys()) };
}

export function bundledLicenses(fullLicenses) {
  const lines = fullLicenses.split(/\r?\n/);
  const rows = sectionLines(lines, inventoryHeading, supplementsHeading)
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map(packageRow);
  const blocks = textBlocks(sectionLines(lines, textsHeading));
  for (const row of rows) {
    for (const [, id] of row.matchAll(/\]\(#([0-9a-f]+)\)/g)) {
      if (!blocks.ids.has(id)) throw new Error(`${row.slice(0, 80)} links to a missing text block ${id}`);
    }
  }
  return [
    preface,
    "## Packages and their license texts",
    "",
    "| Platforms | Package | License | License text |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "## License and notice texts",
    "",
    ...blocks.lines,
  ]
    .join("\n")
    .replace(/\n*$/, "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bundled = bundledLicenses(await readFile(fullFile, "utf8"));
  await mkdir(dirname(bundledFile), { recursive: true });
  await writeFile(bundledFile, bundled);
  console.log(`Wrote ${bundledFile} (${Buffer.byteLength(bundled)} bytes).`);
}
