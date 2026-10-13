import type { ChangeSet, Text } from "@codemirror/state";

export const LARGE_FILE_ENTER_BYTES = 5 * 1024 * 1024;
export const LARGE_FILE_EXIT_BYTES = 4 * 1024 * 1024;

type ChangedRange = { from: number; to: number; nextFrom: number; nextTo: number };

/** UTF-8 size with TextEncoder's replacement behavior for lone surrogates. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Update the exact UTF-8 byte count by scanning only changed spans and one
 * UTF-16 code unit of context around each splice. Context spans that touch are
 * merged so a surrogate pair at a splice edge is measured as one code point.
 */
export function updateUtf8ByteLength(previous: Text, next: Text, changes: Pick<ChangeSet, "iterChanges">): number {
  const ranges: ChangedRange[] = [];
  changes.iterChanges((from, to, nextFrom, nextTo) => {
    const range = {
      from: Math.max(0, from - 1),
      to: Math.min(previous.length, to + 1),
      nextFrom: Math.max(0, nextFrom - 1),
      nextTo: Math.min(next.length, nextTo + 1),
    };
    const last = ranges[ranges.length - 1];
    if (last && (range.from <= last.to || range.nextFrom <= last.nextTo)) {
      last.to = Math.max(last.to, range.to);
      last.nextTo = Math.max(last.nextTo, range.nextTo);
      return;
    }
    ranges.push(range);
  });

  let delta = 0;
  for (const range of ranges) {
    delta += utf8ByteLength(next.sliceString(range.nextFrom, range.nextTo))
      - utf8ByteLength(previous.sliceString(range.from, range.to));
  }
  return delta;
}

export function serializedDocumentByteLength(contentBytes: number, crlfSeparators: number, bom: boolean): number {
  return contentBytes + crlfSeparators + (bom ? 3 : 0);
}

export function largeFileModeForSize(currentLargeFile: boolean, estimatedBytes: number): boolean {
  return currentLargeFile
    ? estimatedBytes >= LARGE_FILE_EXIT_BYTES
    : estimatedBytes > LARGE_FILE_ENTER_BYTES;
}
