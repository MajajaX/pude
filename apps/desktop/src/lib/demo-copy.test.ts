import { describe, expect, it } from "vitest";
import { copyDemoPath, demoFiles, findDemoEntry } from "./demo";

describe("browser demo copy", () => {
  it("copies a folder into another project with its file contents", () => {
    const { path } = copyDemoPath("pude-demo/src", "pude-samples");
    expect(path).toBe("pude-samples/src");
    expect(findDemoEntry("pude-samples/src/main.ts")?.kind).toBe("file");
    expect(demoFiles["pude-samples/src/main.ts"]?.content).toBe(demoFiles["pude-demo/src/main.ts"]?.content);
  });

  it("gives a name collision the same copy names as the desktop", () => {
    expect(copyDemoPath("pude-demo/README.md", "pude-demo").path).toBe("pude-demo/README copy.md");
    expect(copyDemoPath("pude-demo/README.md", "pude-demo").path).toBe("pude-demo/README copy 2.md");
    expect(copyDemoPath("pude-demo/.env", "pude-demo").path).toBe("pude-demo/.env copy");
  });

  it("refuses a folder pasted into itself or a subfolder", () => {
    expect(() => copyDemoPath("pude-demo/assets", "pude-demo/assets")).toThrow("into itself");
    expect(() => copyDemoPath("pude-demo", "pude-demo/src")).toThrow("into itself");
  });
});
