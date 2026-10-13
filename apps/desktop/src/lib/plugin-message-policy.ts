export const MAX_PLUGIN_REQUEST_MESSAGE_BYTES = 64 * 1024;
export const MAX_PLUGIN_RESPONSE_MESSAGE_BYTES = 1024 * 1024;
export const PLUGIN_REQUEST_RATE_LIMIT = 20;
export const PLUGIN_REQUEST_RATE_WINDOW_MS = 1000;
export const PLUGIN_EXECUTION_TIMEOUT_MS = 30_000;
/** Maximum simultaneous API 2 calls retained by one plugin host run. */
export const MAX_PLUGIN_API_V2_IN_FLIGHT_REQUESTS = 512;
/** Keep text responses comfortably within the one-megabyte response envelope. */
export const MAX_PLUGIN_API_V2_TEXT_RANGE_UNITS = 128 * 1024;
/** File chunks are capped before JSON escaping and response-envelope overhead. */
export const MAX_PLUGIN_API_V2_FILE_RANGE_BYTES = 128 * 1024;

const MAX_MESSAGE_NODES = 4096;
const MAX_MESSAGE_DEPTH = 32;

type PendingValue = { value: unknown; depth: number };

function stringByteLength(value: string, maxBytes: number): number {
  if (value.length > maxBytes) return maxBytes + 1;
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Measure the JSON-like data accepted by the plugin protocol without first
 * serializing an attacker-controlled object into another large allocation.
 * Non-plain objects, cyclic structures, deep nesting, and oversized graphs
 * are rejected because the protocol only needs records, arrays, and scalars.
 */
export function isPluginMessageWithinLimit(value: unknown, maxBytes = MAX_PLUGIN_REQUEST_MESSAGE_BYTES): boolean {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return false;

  const pending: PendingValue[] = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;

  const addBytes = (amount: number) => {
    bytes += amount;
    return bytes <= maxBytes;
  };

  while (pending.length > 0) {
    const item = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_MESSAGE_NODES || item.depth > MAX_MESSAGE_DEPTH) return false;

    const current = item.value;
    if (current === null) {
      if (!addBytes(4)) return false;
    } else if (typeof current === "string") {
      if (!addBytes(stringByteLength(current, maxBytes) + 2)) return false;
    } else if (typeof current === "boolean") {
      if (!addBytes(current ? 4 : 5)) return false;
    } else if (typeof current === "number") {
      if (!Number.isFinite(current) || !addBytes(String(current).length)) return false;
    } else if (Array.isArray(current)) {
      if (visited.has(current) || current.length > MAX_MESSAGE_NODES) return false;
      visited.add(current);
      if (!addBytes(2 + Math.max(0, current.length - 1))) return false;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current[index], depth: item.depth + 1 });
      }
    } else if (typeof current === "object") {
      if (visited.has(current)) return false;
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
      visited.add(current);
      let keys: string[];
      try {
        keys = Object.keys(current);
      } catch {
        return false;
      }
      if (keys.length > MAX_MESSAGE_NODES - nodes) return false;
      if (!addBytes(2 + Math.max(0, keys.length - 1))) return false;
      for (const key of keys) {
        if (!addBytes(stringByteLength(key, maxBytes) + 3)) return false;
        let child: unknown;
        try {
          child = (current as Record<string, unknown>)[key];
        } catch {
          return false;
        }
        pending.push({ value: child, depth: item.depth + 1 });
      }
    } else {
      return false;
    }

    if (bytes > maxBytes) return false;
  }

  return true;
}

/** A small rolling-window limiter for each active plugin worker. */
export class PluginMessageRateLimiter {
  private readonly timestamps: number[] = [];

  constructor(
    private readonly limit = PLUGIN_REQUEST_RATE_LIMIT,
    private readonly windowMs = PLUGIN_REQUEST_RATE_WINDOW_MS,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError("Plugin message rate limits must be positive.");
    }
  }

  allow(nowMs = globalThis.performance?.now() ?? Date.now()): boolean {
    if (!Number.isFinite(nowMs)) return false;
    const oldestAllowed = nowMs - this.windowMs;
    while (this.timestamps[0] !== undefined && this.timestamps[0] <= oldestAllowed) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(nowMs);
    return true;
  }

  clear(): void {
    this.timestamps.length = 0;
  }
}

/** Applies the same size and rolling rate budget to a plugin worker's outer protocol messages. */
export class PluginWorkerMessageGate {
  private readonly rateLimiter: PluginMessageRateLimiter;

  constructor(
    private readonly maxBytes = MAX_PLUGIN_REQUEST_MESSAGE_BYTES,
    rateLimit = PLUGIN_REQUEST_RATE_LIMIT,
    rateWindowMs = PLUGIN_REQUEST_RATE_WINDOW_MS,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("Plugin message size limits must be positive.");
    }
    this.rateLimiter = new PluginMessageRateLimiter(rateLimit, rateWindowMs);
  }

  allow(value: unknown, nowMs?: number): boolean {
    return isPluginMessageWithinLimit(value, this.maxBytes) && this.rateLimiter.allow(nowMs);
  }

  clear(): void {
    this.rateLimiter.clear();
  }
}
