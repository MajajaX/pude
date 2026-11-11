import { createHash, createPublicKey, verify } from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PREHASHED_ALGORITHM = "ED";
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";

function decodeBase64Text(base64Text, label) {
  const text = Buffer.from(base64Text, "base64").toString("utf8");
  if (!text.includes("\n")) throw new Error(`${label} is not a base64 encoded minisign file`);
  return text;
}

function decodePayload(line, expectedLength, label) {
  const payload = Buffer.from(line ?? "", "base64");
  if (payload.length !== expectedLength) throw new Error(`${label} payload must be ${expectedLength} bytes, found ${payload.length}`);
  return payload;
}

/** Reads a base64 encoded minisign public key file, as stored in `plugins.updater.pubkey`. */
export function parsePublicKey(publicKeyBase64) {
  const lines = decodeBase64Text(publicKeyBase64, "public key").split(/\r?\n/);
  const payload = decodePayload(lines[1], 42, "public key");
  if (payload.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("public key algorithm must be Ed");
  return { keyId: payload.subarray(2, 10), key: payload.subarray(10) };
}

/** Reads a base64 encoded minisign signature file, as published in a `.sig` file or `latest.json`. */
export function parseSignature(signatureBase64) {
  const lines = decodeBase64Text(signatureBase64, "signature").split(/\r?\n/);
  const payload = decodePayload(lines[1], 74, "signature");
  const trustedLine = lines[2] ?? "";
  if (!trustedLine.startsWith(TRUSTED_COMMENT_PREFIX)) throw new Error("signature has no trusted comment");
  return {
    algorithm: payload.subarray(0, 2).toString("latin1"),
    keyId: payload.subarray(2, 10),
    signature: payload.subarray(10),
    trustedComment: trustedLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature: decodePayload(lines[3], 64, "global signature"),
  };
}

function ed25519Verify(message, publicKey, signature) {
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]), format: "der", type: "spki" });
  return verify(null, message, key, signature);
}

/**
 * Checks a Tauri updater signature the way the installed app does: the prehashed
 * algorithm, the key id and both Ed25519 signatures. Returns the signed trusted comment.
 */
export function verifyUpdateSignature({ publicKeyBase64, signatureBase64, fileBytes }) {
  const publicKey = parsePublicKey(publicKeyBase64);
  const signature = parseSignature(signatureBase64);
  if (signature.algorithm !== PREHASHED_ALGORITHM) throw new Error(`signature algorithm must be ${PREHASHED_ALGORITHM} (prehashed), found ${signature.algorithm}`);
  if (!signature.keyId.equals(publicKey.keyId)) {
    throw new Error(`signature key id ${signature.keyId.toString("hex")} does not match the public key id ${publicKey.keyId.toString("hex")}`);
  }
  const digest = createHash("blake2b512").update(fileBytes).digest();
  if (!ed25519Verify(digest, publicKey, signature.signature)) throw new Error("file signature does not match the file");
  const signedComment = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment)]);
  if (!ed25519Verify(signedComment, publicKey, signature.globalSignature)) throw new Error("trusted comment signature is invalid");
  return signature.trustedComment;
}

/** Reads the `version:` field the Tauri CLI records in the signed trusted comment. */
export function signedVersionOf(trustedComment) {
  return trustedComment.split("\t").find((field) => field.startsWith("version:"))?.slice("version:".length);
}
