/**
 * A small deterministic content fingerprint used to supplement filesystem
 * timestamps and sizes when guarding a save. FNV-1a is intentionally used
 * here because it is available without another runtime dependency; it is a
 * change detector, not a security hash.
 *
 * The 64-bit FNV-1a hash is computed with two 32-bit halves using
 * Math.imul-free integer arithmetic that stays exact below 2^53. This is
 * roughly an order of magnitude faster than a BigInt loop for large files
 * while producing bit-for-bit identical results, which keeps persisted
 * session fingerprints (diskFingerprint) compatible.
 */

const FNV_OFFSET_BASIS_HI = 0xcbf29ce4;
const FNV_OFFSET_BASIS_LO = 0x84222325;
const FNV_PRIME_HI = 0x00000100;
const FNV_PRIME_LO = 0x000001b3;

// Multiply two uint32 values, returning the low and high 32-bit halves of the
// exact 64-bit product. Partial products stay below 2^33, so doubles are exact.
function multiplyUint32(x: number, y: number): [number, number] {
  const xLow = x & 0xffff;
  const xHigh = x >>> 16;
  const yLow = y & 0xffff;
  const yHigh = y >>> 16;
  const lowLow = xLow * yLow;
  const middle = xHigh * yLow + xLow * yHigh;
  const highHigh = xHigh * yHigh;
  const sum = lowLow + (middle & 0xffff) * 0x10000;
  const low = sum >>> 0;
  const high = (highHigh + (middle >>> 16) + Math.floor(sum / 0x100000000)) >>> 0;
  return [low, high];
}

export function contentFingerprint(content: string): string {
  const bytes = new TextEncoder().encode(content);
  let hashHigh = FNV_OFFSET_BASIS_HI;
  let hashLow = FNV_OFFSET_BASIS_LO;
  for (const byte of bytes) {
    // XOR affects only the low half because byte < 256.
    hashLow = (hashLow ^ byte) >>> 0;
    // 64-bit multiply by the FNV prime, keeping only the low 64 bits.
    const [productLow, productHigh] = multiplyUint32(hashLow, FNV_PRIME_LO);
    const cross = (hashLow * FNV_PRIME_HI + hashHigh * FNV_PRIME_LO) >>> 0;
    hashLow = productLow;
    hashHigh = (productHigh + cross) >>> 0;
  }
  return hashHigh.toString(16).padStart(8, "0") + hashLow.toString(16).padStart(8, "0");
}
