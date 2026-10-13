import { For, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import { pluginPermissionLabel, type PluginPermissionGrant } from "../lib/plugin-authorization";
import type { InstalledPlugin, PluginPermission } from "../types";

const isHighRiskPermission = (permission: PluginPermission) => permission === "workspace.write" || permission === "terminal.write" || permission === "network" || permission === "process.spawn:lsp";

const pluginStatusText = (plugin: InstalledPlugin) => plugin.enabled
  ? (plugin.status === "failed" ? "Activation failed" : plugin.status === "active" ? "Active for this session" : "Enabled · inactive")
  : "Disabled";

const pluginStatusId = (pluginId: string) => `plugin-status-${pluginId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

export function PluginModal(props: {
  plugins: InstalledPlugin[];
  grants: PluginPermissionGrant[];
  pendingCleanupIds?: string[];
  onClose: () => void;
  onToggle: (id: string) => void;
  onInstall: () => void;
  onUpdate: (id: string) => void;
  onUninstall: (id: string) => void;
  onRetryCleanup: (id: string) => void;
  onManagePermissions: () => void;
}) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let modalFocus: ModalFocusController | undefined;

  const handleDialogKeyDown = (event: KeyboardEvent) => {
    if (!modalFocus?.isTopmost()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }

    modalFocus.handleKeyDown(event);
  };

  onMount(() => {
    if (dialog) modalFocus = activateModalFocus(dialog, { initialFocus: () => closeButton });
  });

  onCleanup(() => {
    modalFocus?.dispose();
  });

  return (
    <div class="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section ref={(element) => { dialog = element; }} class="modal plugin-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-title" tabIndex={-1} onKeyDown={handleDialogKeyDown}>
        <div class="modal-heading"><div><span class="modal-kicker">EXTENSIONS</span><h2 id="plugin-title">Plugins</h2></div><button ref={(element) => { closeButton = element; }} type="button" class="icon-button" onClick={props.onClose} aria-label="Close plugins dialog"><Icon name="close" /></button></div>
        <div class="plugin-list">
          <For each={props.plugins} fallback={<p class="plugin-empty">No plugins installed.</p>}>{(plugin) => (
            <article class="plugin-card">
              <div class="plugin-card-top"><div class="plugin-icon"><Icon name="plugin" size={18} /></div><div class="plugin-title-block"><h3>{plugin.name}</h3><span>{plugin.id} · v{plugin.version}</span></div><button type="button" classList={{ "toggle-switch": true, "toggle-on": plugin.enabled }} onClick={() => props.onToggle(plugin.id)} aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`} aria-pressed={plugin.enabled} aria-describedby={pluginStatusId(plugin.id)}><span aria-hidden="true" /></button></div>
              <div class="plugin-status-row"><span classList={{ "status-dot": true, "status-dot-active": plugin.enabled && plugin.status === "active" }} aria-hidden="true" /><span id={pluginStatusId(plugin.id)} role="status" aria-live="polite" aria-atomic="true">{pluginStatusText(plugin)}</span><span class="plugin-api">API {plugin.apiVersion}</span></div>
              <div class="permission-list"><span class="permission-heading"><Icon name="lock" size={12} /> REQUESTED PERMISSIONS</span><For each={plugin.permissions}>{(permission) => { const highRisk = isHighRiskPermission(permission); return <span classList={{ "permission-item": true, "permission-risk": highRisk }}><Icon name={highRisk ? "lock" : "check"} size={12} />{pluginPermissionLabel(permission)}</span>; }}</For></div>
              <div class="plugin-card-actions">
                <button type="button" class="secondary-button" onClick={() => props.onUpdate(plugin.id)}>Update from folder</button>
                <button type="button" class="danger-button" onClick={() => props.onUninstall(plugin.id)}>Uninstall</button>
              </div>
            </article>
          )}</For>
          <For each={props.pendingCleanupIds ?? []}>{(pluginId) => (
            <article class="plugin-card plugin-cleanup-card">
              <div class="plugin-title-block">
                <h3>{pluginId === "__pude_plugin_staging__" ? "Incomplete install cleanup pending" : "Plugin data cleanup pending"}</h3>
                <span>{pluginId === "__pude_plugin_staging__" ? "Abandoned plugin staging data" : pluginId}</span>
              </div>
              <p>Some plugin files could not be removed yet. Retry cleanup when they can be accessed.</p>
              <button type="button" class="secondary-button" onClick={() => props.onRetryCleanup(pluginId)}>Retry cleanup</button>
            </article>
          )}</For>
        </div>
        <div class="modal-footer plugin-modal-footer">
          <span class="modal-footnote"><Icon name="lock" size={12} /> Permissions are deny-by-default</span>
          <div>
            <button type="button" class="secondary-button" onClick={props.onManagePermissions}>Manage permissions ({props.grants.length})</button>
            <button type="button" class="secondary-button" onClick={props.onInstall}><Icon name="plus" size={13} /> Install local plugin</button>
          </div>
        </div>
      </section>
    </div>
  );
}
