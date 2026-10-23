import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import zhHant from "./zh-Hant";

const sourceRoot = join(__dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("Traditional Chinese interface text", () => {
  it("translates every interface string in the source", () => {
    const keys = new Set<string>();
    for (const file of sourceFiles(sourceRoot)) {
      for (const match of readFileSync(file, "utf8").matchAll(/\b(?:t|translatable)\(\s*("(?:[^"\\\n]|\\.)*")/g)) keys.add(JSON.parse(match[1]));
    }
    expect(keys.size).toBeGreaterThan(500);
    expect([...keys].filter((key) => !(key in zhHant))).toEqual([]);
  });

  it("keeps the same placeholders as the English text", () => {
    expect(Object.entries(zhHant).filter(([key, value]) => placeholders(key).join() !== placeholders(value).join())).toEqual([]);
  });
});
