import { describe, expect, it } from "vitest";
import { parseInstalledPlugin, parsePluginManifest } from "./plugin-manifest";

const legacyInstalledManifest = {
  id: "pude.example",
  name: "Example plugin",
  version: "0.1.0",
  apiVersion: "1",
  entry: "dist/extension.js",
  permissions: ["editor.read", "commands.register", "ui.notification"],
  activationEvents: ["onCommand:pude.example.run"],
};

describe("plugin manifest API versions", () => {
  it("continues to accept the installed API 1 manifest shape and permissions", () => {
    expect(parsePluginManifest(legacyInstalledManifest)).toEqual(legacyInstalledManifest);
    expect(parsePluginManifest({ ...legacyInstalledManifest, permissions: ["workspace.read"] })).toBeNull();
    expect(parseInstalledPlugin({
      ...legacyInstalledManifest,
      enabled: true,
      status: "active",
      source: "local",
      rootPath: "C:/Users/example/AppData/plugins/pude.example",
    })).toEqual({
      ...legacyInstalledManifest,
      enabled: true,
      status: "inactive",
      source: "local",
      rootPath: "C:/Users/example/AppData/plugins/pude.example",
    });
  });

  it("accepts API 2 and the complete approved permission-name set", () => {
    const manifest = {
      ...legacyInstalledManifest,
      apiVersion: "2",
      permissions: [
        "editor.read",
        "editor.write",
        "workspace.read",
        "workspace.write",
        "commands.register",
        "ui.notification",
        "ui.statusBar",
        "ui.quickPick",
        "git.read",
        "terminal.write",
        "network",
        "process.spawn:lsp",
      ],
    };
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    expect(parsePluginManifest({ ...manifest, permissions: ["process.spawn"] })).toBeNull();
    expect(parsePluginManifest({ ...manifest, apiVersion: "3" })).toBeNull();
  });

  it("accepts validated command contributions and each supported event declaration", () => {
    const manifest = {
      ...legacyInstalledManifest,
      activationEvents: [
        "onCommand:pude.example.run",
        "onLanguage:typescript",
        "onFileOpen",
        "onFileSave",
        "onWorkspaceOpen",
      ],
      contributes: { commands: [{ command: "pude.example.run", title: "Example: Run" }] },
    };
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    expect(parsePluginManifest({ ...manifest, activationEvents: ["onFileClose"] })).toBeNull();
    expect(parsePluginManifest({ ...manifest, activationEvents: ["lsp.message"] })).toBeNull();
    expect(parsePluginManifest({ ...manifest, contributes: { commands: [{ command: "invalid command", title: "Run" }] } })).toBeNull();
    expect(parsePluginManifest({ ...manifest, contributes: { commands: [{ command: "pude.example.run", title: " " }] } })).toBeNull();
    expect(parsePluginManifest({ ...manifest, contributes: { commands: [{ command: "pude.example.run", title: "Run" }, { command: "pude.example.run", title: "Run twice" }] } })).toBeNull();
  });
});
