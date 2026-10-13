import { describe, expect, it } from "vitest";
import { createDiagnosticRateLimiter, formatDiagnostic } from "./diagnostics";

describe("frontend diagnostics", () => {
  it("keeps stage and code while omitting arbitrary error text", () => {
    const error = new Error(
      "document-body-sentinel token=token-sentinel -----BEGIN PRIVATE KEY-----private-key-sentinel",
    ) as Error & { code: string };
    error.code = "EACCES";

    const message = formatDiagnostic("save", error);

    expect(message).toBe("stage=save; error=Error; code=EACCES");
    expect(message).not.toContain("document-body-sentinel");
    expect(message).not.toContain("token-sentinel");
    expect(message).not.toContain("private-key-sentinel");
  });

  it("uses generic summaries for strings and objects without converting them", () => {
    const error = {
      message: "document-body-sentinel",
      toString() {
        throw new Error("should not be called");
      },
    };

    expect(formatDiagnostic("plugin.restore", "token-sentinel")).toBe(
      "stage=plugin.restore; error=string",
    );
    expect(formatDiagnostic("restore", error)).toBe("stage=restore; error=object");
  });

  it("does not invoke an error code getter", () => {
    let codeRead = false;
    const error = Object.defineProperty({}, "code", {
      get() {
        codeRead = true;
        throw new Error("must not be read");
      },
    });

    expect(formatDiagnostic("restore", error)).toBe("stage=restore; error=object");
    expect(codeRead).toBe(false);
  });

  it("rejects sensitive or malformed stage and code labels", () => {
    expect(formatDiagnostic("document-body-sentinel", new Error("private"), "token-sentinel")).toBe(
      "stage=unknown; error=Error",
    );
    expect(formatDiagnostic("save", new Error("private"), "EACCES; token=secret")).toBe(
      "stage=save; error=Error",
    );
  });

  it("limits reports to 20 per minute and reopens the window at its boundary", () => {
    let time = 100;
    const shouldReport = createDiagnosticRateLimiter(50, () => time);

    for (let index = 0; index < 20; index += 1) {
      expect(shouldReport()).toBe(true);
    }
    expect(shouldReport()).toBe(false);

    time += 59_999;
    expect(shouldReport()).toBe(false);
    time += 1;
    expect(shouldReport()).toBe(true);
  });
});
