import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_REQUEST_MESSAGE_BYTES,
  MAX_PLUGIN_RESPONSE_MESSAGE_BYTES,
  MAX_PLUGIN_API_V2_FILE_RANGE_BYTES,
  MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS,
  PluginMessageRateLimiter,
  PluginWorkerMessageGate,
  PLUGIN_EXECUTION_TIMEOUT_MS,
  isPluginMessageWithinLimit,
} from "./plugin-message-policy";

describe("plugin message limits", () => {
  it("accepts bounded JSON-like protocol envelopes", () => {
    expect(isPluginMessageWithinLimit({
      type: "api-request",
      protocolVersion: 2,
      requestId: "pude_1",
      method: "ui.notify",
      params: { message: "Saved" },
    })).toBe(true);
  });

  it("counts UTF-8 text and envelope overhead while keeping range responses below budget", () => {
    expect(isPluginMessageWithinLimit("x", 3)).toBe(true);
    expect(isPluginMessageWithinLimit("x", 2)).toBe(false);
    expect(isPluginMessageWithinLimit("界", 5)).toBe(true);
    expect(isPluginMessageWithinLimit("界", 4)).toBe(false);
    expect(isPluginMessageWithinLimit("🙂", 6)).toBe(true);
    expect(isPluginMessageWithinLimit("🙂", 5)).toBe(false);
    expect(isPluginMessageWithinLimit({ content: "x" }, 15)).toBe(true);
    expect(isPluginMessageWithinLimit({ content: "x" }, 14)).toBe(false);
    expect(MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS).toBe(128 * 1024);
    expect(MAX_PLUGIN_API_V2_FILE_RANGE_BYTES).toBe(128 * 1024);
    expect(isPluginMessageWithinLimit({ content: "\u0001".repeat(MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS) }, MAX_PLUGIN_RESPONSE_MESSAGE_BYTES)).toBe(true);
    expect(isPluginMessageWithinLimit({ content: "\u0001".repeat(MAX_PLUGIN_API_V2_FILE_RANGE_BYTES) }, MAX_PLUGIN_RESPONSE_MESSAGE_BYTES)).toBe(true);
  });

  it("rejects oversized, deep, cyclic, and non-JSON protocol values", () => {
    expect(isPluginMessageWithinLimit("x".repeat(MAX_PLUGIN_REQUEST_MESSAGE_BYTES))).toBe(false);
    expect(isPluginMessageWithinLimit({ result: "x".repeat(MAX_PLUGIN_RESPONSE_MESSAGE_BYTES) }, MAX_PLUGIN_RESPONSE_MESSAGE_BYTES)).toBe(false);

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 34; depth += 1) nested = { nested };
    expect(isPluginMessageWithinLimit(nested)).toBe(false);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isPluginMessageWithinLimit(cycle)).toBe(false);
    expect(isPluginMessageWithinLimit(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("enforces a rolling request rate per worker", () => {
    const limiter = new PluginMessageRateLimiter(2, 1000);
    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(100)).toBe(true);
    expect(limiter.allow(500)).toBe(false);
    expect(limiter.allow(1000)).toBe(true);
    limiter.clear();
    expect(limiter.allow(1001)).toBe(true);
  });

  it("bounds non-API worker messages by size and rate per run", () => {
    const gate = new PluginWorkerMessageGate(64, 2, 1000);
    expect(gate.allow({ type: "ready" }, 0)).toBe(true);
    expect(gate.allow({ type: "status", text: "x".repeat(64) }, 100)).toBe(false);
    expect(gate.allow({ type: "subscriptions", events: ["onFileOpen"] }, 200)).toBe(true);
    expect(gate.allow({ type: "done" }, 500)).toBe(false);
    gate.clear();
    expect(gate.allow({ type: "done" }, 501)).toBe(true);
  });

  it("publishes bounded response and execution budgets", () => {
    expect(MAX_PLUGIN_RESPONSE_MESSAGE_BYTES).toBe(1024 * 1024);
    expect(PLUGIN_EXECUTION_TIMEOUT_MS).toBe(30_000);
  });
});
