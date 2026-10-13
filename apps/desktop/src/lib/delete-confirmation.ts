export type TrashTargetPlatform = "mac" | "windows" | "linux";

export function trashLocationLabel(platform: TrashTargetPlatform): string {
  if (platform === "windows") return "Recycle Bin";
  if (platform === "mac") return "Trash";
  return "system trash";
}

export function deleteConfirmationMessage(
  itemName: string,
  platform: TrashTargetPlatform,
  affectedOpenTabs: number,
  hasDirtyTabs: boolean,
): string {
  const location = platform === "linux"
    ? "system trash"
    : `the ${trashLocationLabel(platform)}`;
  const prompt = `Move ${itemName} to ${location}?`;

  if (hasDirtyTabs) {
    return `${prompt} Unsaved changes in affected open tabs will be discarded, and those tabs will be closed.`;
  }
  if (affectedOpenTabs > 0) {
    return `${prompt} Affected open tabs will be closed.`;
  }
  return prompt;
}
