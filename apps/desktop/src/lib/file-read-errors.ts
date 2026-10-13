export function isMissingFileReadError(error: unknown, platform: "posix" | "windows"): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const match = /^Unable to read file\. [^\r\n]*\(os error (\d+)\)$/.exec(message);
  return Boolean(match && (match[1] === "2" || (platform === "windows" && match[1] === "3")));
}
