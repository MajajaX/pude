import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recordPaths = ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.md"];
const blockers = [];

for (const relativePath of recordPaths) {
  const contents = await readFile(resolve(root, relativePath), "utf8");
  const markerCandidates = contents.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^<!--\s*release-readiness:/i.test(line));
  const approvedMarkers = markerCandidates.filter((line) => line === "<!-- release-readiness: approved -->");

  if (markerCandidates.length !== 1) {
    blockers.push(`${relativePath}: expected exactly one release-readiness marker, found ${markerCandidates.length}`);
  } else if (approvedMarkers.length !== 1) {
    blockers.push(`${relativePath}: release-readiness marker must be exactly '<!-- release-readiness: approved -->' before formal release`);
  }
}

if (blockers.length > 0) {
  console.error("Formal release is blocked by missing, duplicate, or unresolved legal-review signoffs:");
  for (const blocker of blockers) console.error(`  ${blocker}`);
  process.exit(1);
}

console.log("Third-party notice and full-license inventories each have one explicit approved release signoff.");
