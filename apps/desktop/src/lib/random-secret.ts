export type SecretFormat = "hex" | "base64" | "base64url" | "alphanumeric" | "uuid";
export type SecretOptions = { format: SecretFormat; length: number };
export const DEFAULT_SECRET_OPTIONS: SecretOptions = { format: "base64url", length: 32 };
export const SECRET_OPTIONS_KEY = "pude.env.secret-options";

export function readSecretOptions(): SecretOptions {
  try {
    const value = JSON.parse(localStorage.getItem(SECRET_OPTIONS_KEY) ?? "null");
    if (
      ["hex", "base64", "base64url", "alphanumeric", "uuid"].includes(value?.format) &&
      Number.isInteger(value?.length) &&
      value.length >= 1 &&
      value.length <= 1024
    )
      return value;
  } catch {
    /* Storage may be unavailable or contain invalid data. */
  }
  return { ...DEFAULT_SECRET_OPTIONS };
}

export function saveSecretOptions(options: SecretOptions): void {
  try {
    localStorage.setItem(SECRET_OPTIONS_KEY, JSON.stringify({ format: options.format, length: options.length }));
  } catch {
    /* The generator still works without persistence. */
  }
}

export function generateSecret({ format, length }: SecretOptions): string {
  if (format === "uuid") return crypto.randomUUID();
  if (!Number.isInteger(length) || length < 1 || length > 1024) throw new RangeError("Invalid secret length");
  if (format === "alphanumeric") {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    while (result.length < length) {
      const bytes = crypto.getRandomValues(new Uint8Array(length - result.length));
      for (const byte of bytes) if (byte < 248) result += alphabet[byte % 62];
    }
    return result;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  if (format === "hex") return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  return format === "base64url" ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : encoded;
}
