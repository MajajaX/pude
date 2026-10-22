import { describe, expect, it } from "vitest";
import { splitDisplayPath } from "./display-path";

describe("display path", () => {
  it("splits display paths into file name and parent directory", () => {
    expect(splitDisplayPath("src/lib/core.ts")).toEqual({ name: "core.ts", directory: "src/lib" });
    expect(splitDisplayPath("src\\main.rs")).toEqual({ name: "main.rs", directory: "src" });
    expect(splitDisplayPath("README.md")).toEqual({ name: "README.md", directory: "" });
  });
});
