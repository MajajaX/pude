type PluginEditorRevisionSnapshot = {
  tabId: string;
  documentRevision: number;
  selectionGeneration: number;
};

const MAX_PLUGIN_EDITOR_REVISION_SNAPSHOTS = 1024;

/** Bind API revision tokens to both the concrete document and active-tab selection. */
export class PluginEditorRevisionTracker {
  private nextRevision = 1;
  private readonly snapshots = new Map<number, PluginEditorRevisionSnapshot>();

  capture(tabId: string, documentRevision: number, selectionGeneration: number): number {
    const token = this.nextRevision++;
    this.snapshots.set(token, { tabId, documentRevision, selectionGeneration });
    while (this.snapshots.size > MAX_PLUGIN_EDITOR_REVISION_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    return token;
  }

  matches(
    token: number,
    tabId: string,
    documentRevision: number,
    selectionGeneration: number,
  ): boolean {
    const snapshot = this.snapshots.get(token);
    return snapshot !== undefined
      && snapshot.tabId === tabId
      && snapshot.documentRevision === documentRevision
      && snapshot.selectionGeneration === selectionGeneration;
  }

  clear(): void {
    this.snapshots.clear();
  }
}
