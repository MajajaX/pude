import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SETTINGS_STORAGE_KEY } from "../src/lib/settings";

const script = readFileSync(new URL("../public/startup.js", import.meta.url), "utf8");

function runStartupScript(stored: string | null | "throws") {
  const dataset: Record<string, string> = {};
  const readKeys: string[] = [];
  runInNewContext(script, {
    document: { documentElement: { dataset } },
    localStorage: {
      getItem(key: string) {
        readKeys.push(key);
        if (stored === "throws") throw new Error("storage is blocked");
        return stored;
      },
    },
  });
  return { dataset, readKeys };
}

describe("startup script", () => {
  it("applies the stored light theme to the document before the app loads", () => {
    const { dataset, readKeys } = runStartupScript(JSON.stringify({ theme: "light" }));
    expect(readKeys).toEqual([SETTINGS_STORAGE_KEY]);
    expect(dataset.theme).toBe("light");
  });

  it.each([
    ["dark", JSON.stringify({ theme: "dark" })],
    ["missing", null],
    ["invalid JSON", "{"],
    ["unreadable", "throws" as const],
  ])("leaves the default dark theme when the stored settings are %s", (_name, stored) => {
    expect(runStartupScript(stored).dataset.theme).toBeUndefined();
  });
});
