import { t } from "./i18n";

export type TrashTargetPlatform = "mac" | "windows" | "linux";

export function trashLocationLabel(platform: TrashTargetPlatform): string {
  if (platform === "windows") return t("Recycle Bin");
  if (platform === "mac") return t("Trash");
  return t("system trash");
}

export function deleteConfirmationMessage(
  itemName: string,
  platform: TrashTargetPlatform,
  affectedOpenTabs: number,
  hasDirtyTabs: boolean,
): string {
  const prompt = platform === "linux"
    ? t("Move {name} to system trash?", { name: itemName })
    : t("Move {name} to the {location}?", { name: itemName, location: trashLocationLabel(platform) });

  if (hasDirtyTabs) {
    return t("{prompt} Unsaved changes in affected open tabs will be discarded, and those tabs will be closed.", { prompt });
  }
  if (affectedOpenTabs > 0) {
    return t("{prompt} Affected open tabs will be closed.", { prompt });
  }
  return prompt;
}
