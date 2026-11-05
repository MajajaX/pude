import { describe, expect, it } from "vitest";
import { DEFAULT_SECRET_OPTIONS, generateSecret, readSecretOptions } from "./random-secret";
describe("random secrets", () => {
  it("generates valid representations", () => {
    expect(generateSecret(DEFAULT_SECRET_OPTIONS)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSecret({ format: "hex", length: 32 })).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret({ format: "base64", length: 32 })).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(generateSecret({ format: "alphanumeric", length: 128 })).toMatch(/^[A-Za-z0-9]{128}$/);
    expect(generateSecret({ format: "uuid", length: 32 })).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(generateSecret(DEFAULT_SECRET_OPTIONS)).not.toBe(generateSecret(DEFAULT_SECRET_OPTIONS));
  });
  it("rejects invalid lengths and handles unavailable storage", () => {
    expect(() => generateSecret({ format: "hex", length: 1025 })).toThrow();
    expect(readSecretOptions()).toEqual(DEFAULT_SECRET_OPTIONS);
  });
});
