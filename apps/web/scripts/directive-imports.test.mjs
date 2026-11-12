import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const componentsDirectory = new URL("../src/components/", import.meta.url);

// Solid compiles `use:name` into a call to a local `name`, which linters treat as unused.
// A missing import throws during hydration and stops every scroll animation on the page.
test("every use: directive in a component is imported", () => {
  const missing = [];
  for (const file of readdirSync(componentsDirectory).filter((name) => name.endsWith(".tsx"))) {
    const source = readFileSync(new URL(file, componentsDirectory), "utf8");
    const directives = new Set([...source.matchAll(/\buse:([A-Za-z_$][\w$]*)/g)].map((match) => match[1]));
    for (const directive of directives) {
      const imported = new RegExp(`^import\\s*\\{[^}]*\\b${directive}\\b[^}]*\\}\\s*from`, "m").test(source);
      if (!imported) missing.push(`${file}: use:${directive}`);
    }
  }
  assert.deepEqual(missing, []);
});
