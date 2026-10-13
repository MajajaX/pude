import type { EditorTab } from "../types";
import type { StatFileEntry } from "./bridge";

export function diskMetadataChanged(tab: EditorTab, entry?: StatFileEntry): boolean {
  return !entry
    || entry.modifiedAt === null
    || entry.modifiedAt !== tab.diskModifiedAt
    || entry.size === null
    || entry.size !== tab.diskSize
    || entry.identity === null
    || entry.identity !== tab.diskIdentity;
}
