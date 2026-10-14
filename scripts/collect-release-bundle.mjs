import { copyFile, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [platform, outputDirectory, ...extraArguments] = process.argv.slice(2);
if (!new Set(["windows", "macos"]).has(platform) || !outputDirectory) {
  throw new Error("usage: collect-release-bundle.mjs <windows|macos> <output-directory> --bundle-root <cargo-target-directory>");
}

if (extraArguments.length !== 2 || extraArguments[0] !== "--bundle-root" || !extraArguments[1]) {
  throw new Error("--bundle-root must be followed by the Cargo target directory");
}
const bundleRoot = resolve(extraArguments[1]);
const outputRoot = resolve(outputDirectory);
const isWithin = (parent, candidate) => {
  const childPath = relative(parent, candidate);
  return childPath === "" || (!childPath.startsWith(`..${sep}`) && childPath !== ".." && !isAbsolute(childPath));
};
if (isWithin(bundleRoot, outputRoot) || isWithin(outputRoot, bundleRoot)) {
  throw new Error("output directory and Cargo target directory must be separate trees");
}
const bundleFiles = {
  windows: [
    { directory: /(?:^|\/)release\/bundle\/nsis\//, extension: ".exe", outputName: "pude-windows-x64-setup.exe" },
    { directory: /(?:^|\/)release\/bundle\/nsis\//, extension: ".exe.sig", outputName: "pude-windows-x64-setup.exe.sig" },
  ],
  macos: [
    { directory: /(?:^|\/)release\/bundle\/dmg\//, extension: ".dmg", outputName: "pude-macos-arm64.dmg" },
    { directory: /(?:^|\/)release\/bundle\/macos\//, extension: ".app.tar.gz", outputName: "pude-macos-arm64.app.tar.gz" },
    { directory: /(?:^|\/)release\/bundle\/macos\//, extension: ".app.tar.gz.sig", outputName: "pude-macos-arm64.app.tar.gz.sig" },
  ],
}[platform];
const matches = bundleFiles.map(() => []);

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(bundleRoot, path).split(sep).join("/");
    bundleFiles.forEach(({ directory, extension }, index) => {
      if (directory.test(relativePath) && path.toLowerCase().endsWith(extension)) matches[index].push(path);
    });
  }
}

await walk(bundleRoot);
bundleFiles.forEach(({ outputName }, index) => {
  if (matches[index].length !== 1) {
    throw new Error(`expected exactly one ${outputName} source, found ${matches[index].length}`);
  }
});

await mkdir(outputRoot, { recursive: true });
for (const [index, { outputName }] of bundleFiles.entries()) {
  await copyFile(matches[index][0], join(outputRoot, outputName));
}
for (const legalFile of ["LICENSE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.md"]) {
  await copyFile(resolve(root, legalFile), join(outputRoot, legalFile));
}
console.log(`Collected ${bundleFiles.map(({ outputName }) => outputName).join(", ")}, LICENSE, THIRD_PARTY_NOTICES.md, and THIRD_PARTY_LICENSES.md into ${outputRoot}.`);
