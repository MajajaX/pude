const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SENSITIVE_LABEL_SEGMENT = /(?:^|[._-])(token|secret|password|private|credential|bearer|sentinel|body|document|content|key)(?:$|[._-])/i;
const MAX_DIAGNOSTIC_LENGTH = 192;
const MAX_REPORTS_PER_MINUTE = 20;
const REPORT_WINDOW_MS = 60_000;

function safeLabel(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !LABEL_PATTERN.test(value) ||
    SENSITIVE_LABEL_SEGMENT.test(value)
  ) {
    return undefined;
  }
  return value;
}

function errorKind(error: unknown): string {
  try {
    if (error instanceof Error) return "Error";
  } catch {
    // A thrown Proxy can make instanceof throw. Keep the diagnostic generic.
  }

  switch (typeof error) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    case "object":
      return error === null ? "null" : "object";
    default:
      return "unknown";
  }
}

function ownErrorCode(error: unknown): string | undefined {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "code");
    return descriptor && "value" in descriptor ? safeLabel(descriptor.value) : undefined;
  } catch {
    // A hostile Proxy may throw while its own properties are inspected.
    return undefined;
  }
}

/**
 * Build a log-safe summary. Error messages and arbitrary thrown values are
 * deliberately omitted because they can contain file contents or secrets.
 */
export function formatDiagnostic(stage: string, error: unknown, code?: unknown): string {
  const safeStage = safeLabel(stage) ?? "unknown";
  const safeCode = safeLabel(code) ?? ownErrorCode(error);
  const fields = [`stage=${safeStage}`, `error=${errorKind(error)}`];
  if (safeCode) fields.push(`code=${safeCode}`);
  return fields.join("; ").slice(0, MAX_DIAGNOSTIC_LENGTH);
}

/** Allow at most 20 frontend diagnostic writes in each 60-second window. */
export function createDiagnosticRateLimiter(
  requestedLimit = MAX_REPORTS_PER_MINUTE,
  now: () => number = Date.now,
): () => boolean {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_REPORTS_PER_MINUTE, Math.floor(requestedLimit)))
    : MAX_REPORTS_PER_MINUTE;
  let windowStartedAt: number | undefined;
  let reportsInWindow = 0;

  return () => {
    const currentTime = now();
    if (
      windowStartedAt === undefined ||
      currentTime < windowStartedAt ||
      currentTime - windowStartedAt >= REPORT_WINDOW_MS
    ) {
      windowStartedAt = currentTime;
      reportsInWindow = 0;
    }
    if (reportsInWindow >= limit) return false;
    reportsInWindow += 1;
    return true;
  };
}

const allowDiagnostic = createDiagnosticRateLimiter();

/** Share the write limit across frontend error paths without exposing error payloads. */
export function emitDiagnostic(stage: string, error: unknown, sink: (message: string) => void = (message) => console.error(message), code?: unknown): void {
  if (allowDiagnostic()) sink(formatDiagnostic(stage, error, code));
}
