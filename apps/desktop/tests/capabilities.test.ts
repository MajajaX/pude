import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri command permissions", () => {
  it("allows every registered command in trusted application windows", () => {
    const buildScript = readFileSync(new URL("../src-tauri/build.rs", import.meta.url), "utf8");
    const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8")) as { permissions: string[] };
    const commandList = buildScript.match(/const COMMANDS: &[\s\S]*?= &\[([\s\S]*?)\];/)?.[1];
    expect(commandList).toBeDefined();
    const registeredCommands = [...commandList!.matchAll(/^\s*"([a-z][a-z_]+)",$/gm)].map((match) => match[1]);
    const allowedCommands = capability.permissions
      .filter((permission) => permission.startsWith("allow-"))
      .map((permission) => permission.slice("allow-".length).replaceAll("-", "_"));

    expect(registeredCommands.length).toBeGreaterThan(0);
    expect(allowedCommands).toEqual(registeredCommands);
  });
});
