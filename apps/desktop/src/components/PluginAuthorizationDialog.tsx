import { For, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { activateModalFocus, type ModalFocusController } from "../lib/modal-focus";
import {
  buildPluginPermissionReview,
  isPluginPermissionHighRisk,
  pluginAuthorizationActionLabels,
  pluginPermissionLabel,
  type PluginAuthorizationReviewManifest,
  type PluginPermissionGrant,
  type PluginPermissionGrantRequest,
} from "../lib/plugin-authorization";
import type { InstalledPlugin } from "../types";

function useDialogFocus(onClose: () => void) {
  let dialog: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let controller: ModalFocusController | undefined;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!controller?.isTopmost()) return;

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    controller.handleKeyDown(event);
  };

  onMount(() => {
    if (dialog) controller = activateModalFocus(dialog, { initialFocus: () => closeButton ?? null });
  });
  onCleanup(() => {
    controller?.dispose();
    controller = undefined;
  });

  return {
    setDialog: (element: HTMLElement) => { dialog = element; },
    setCloseButton: (element: HTMLButtonElement) => { closeButton = element; },
    handleKeyDown,
  };
}

export function PluginAuthorizationDialog(props: {
  current?: PluginAuthorizationReviewManifest;
  proposed: PluginAuthorizationReviewManifest;
  existingGrants: PluginPermissionGrant[];
  workspaceRoot: string;
  onApprove: (grants: PluginPermissionGrantRequest[]) => void | Promise<void>;
  onCancel: () => void;
}) {
  const focus = useDialogFocus(props.onCancel);
  const reviewItems = () => buildPluginPermissionReview({
    current: props.current,
    proposed: props.proposed,
    existingGrants: props.existingGrants,
    workspaceRoot: props.workspaceRoot,
  });
  const defaultSelected = new Set(reviewItems()
    .filter((item) => item.available
      && !item.added
      && item.previouslyGranted
      && (!isPluginPermissionHighRisk(item.permission) || !item.requiresFreshApproval))
    .map((item) => item.key));
  const [selectedKeys, setSelectedKeys] = createSignal(defaultSelected);
  const [submitting, setSubmitting] = createSignal(false);
  const [submitError, setSubmitError] = createSignal<string>();
  const selectedRequests = () => reviewItems()
    .filter((item) => item.available && selectedKeys().has(item.key))
    .map((item) => item.grantRequest);
  const actionLabels = () => pluginAuthorizationActionLabels(Boolean(props.current), selectedRequests().length);
  const toggleItem = (key: string) => setSelectedKeys((previous) => {
    const next = new Set(previous);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const heading = () => props.current ? "Review plugin update" : "Review plugin permissions";
  const approve = async () => {
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await props.onApprove(selectedRequests());
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not save plugin permissions.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div class="modal-backdrop plugin-authorization-backdrop" onClick={(event) => { if (event.target === event.currentTarget) props.onCancel(); }}>
      <section ref={focus.setDialog} class="modal plugin-authorization-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-authorization-title" tabIndex={-1} onKeyDown={focus.handleKeyDown}>
        <div class="modal-heading">
          <div><span class="modal-kicker">PLUGIN SECURITY</span><h2 id="plugin-authorization-title">{heading()}</h2></div>
          <button ref={focus.setCloseButton} type="button" class="icon-button" onClick={props.onCancel} aria-label="Cancel permission review"><Icon name="close" /></button>
        </div>
        <div class="plugin-authorization-summary">
          <strong>{props.proposed.name}</strong>
          <span>{props.proposed.id} · v{props.proposed.version}</span>
          <span>Workspace: {props.workspaceRoot || "No workspace open"}</span>
          <p>{props.current
            ? `Approving replaces the grants for v${props.proposed.version} with the selected permissions. Cancel keeps the installed version and its current grants.`
            : "Choose which permissions this version can use. You may install it with no permissions; cancel discards this pending install."}</p>
          <p>{props.proposed.apiVersion === "1"
            ? "API 1 receives only the selected legacy editor, command, and UI capabilities. This review does not isolate plugin code; install source you trust."
            : "API 2 host calls require the selected permissions and matching grants."}</p>
        </div>
        <div class="plugin-authorization-list">
          <For each={reviewItems()} fallback={<p class="plugin-empty">This plugin did not request any permissions.</p>}>
            {(item) => (
              <label classList={{
                "plugin-authorization-item": true,
                "plugin-authorization-item-unavailable": !item.available,
                "permission-risk": isPluginPermissionHighRisk(item.permission),
              }}>
                <input
                  type="checkbox"
                  checked={selectedKeys().has(item.key)}
                  disabled={!item.available}
                  aria-label={`${item.label}${item.added ? ", added" : ""}`}
                  onChange={() => toggleItem(item.key)}
                />
                <span class="plugin-authorization-item-copy">
                  <span class="plugin-authorization-item-heading">
                    <strong>{item.label}</strong>
                    {isPluginPermissionHighRisk(item.permission) && <span class="plugin-authorization-risk-badge">HIGH RISK</span>}
                    {item.added && <span class="plugin-authorization-new-badge">NEW</span>}
                  </span>
                  <For each={item.details}>{(detail) => <span class="plugin-authorization-detail">{detail}</span>}</For>
                  {item.unavailableReason && <span class="plugin-authorization-unavailable">{item.unavailableReason}</span>}
                  {item.previouslyGranted && <span class="plugin-authorization-previous">Previously approved for this plugin</span>}
                </span>
              </label>
            )}
          </For>
        </div>
        <div class="modal-footer plugin-authorization-footer">
          <div class="plugin-authorization-footer-note">
            <span class="modal-footnote"><Icon name="lock" size={12} /> Approval applies to v{props.proposed.version}</span>
            {submitError() && <span class="plugin-authorization-error" role="alert">{submitError()}</span>}
          </div>
          <div class="plugin-authorization-actions">
            <button type="button" class="secondary-button" disabled={submitting()} onClick={props.onCancel}>{actionLabels().cancel}</button>
            <button type="button" class="primary-button" disabled={submitting()} onClick={() => void approve()}>
              {submitting() ? "Saving…" : actionLabels().approve}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function scopeText(grant: PluginPermissionGrant): string {
  const details = [
    grant.workspaceRoot ? `Workspace: ${grant.workspaceRoot}` : "All workspaces",
  ];
  if (grant.resourceScope?.kind === "domain") details.push(`HTTPS domain: ${grant.resourceScope.value}`);
  if (grant.resourceScope?.kind === "executable") {
    details.push(`Server: ${grant.resourceScope.serverId} (${grant.resourceScope.language})`);
    details.push(`Executable: ${grant.resourceScope.executablePath}`);
    details.push(`Arguments: ${JSON.stringify(grant.resourceScope.args)}`);
  }
  return details.join(" · ");
}

export function PluginAuthorizationManagementDialog(props: {
  plugins: InstalledPlugin[];
  grants: PluginPermissionGrant[];
  onRevoke: (grantId: string) => void;
  onClose: () => void;
}) {
  const focus = useDialogFocus(props.onClose);
  const pluginName = (pluginId: string) => props.plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;

  return (
    <div class="modal-backdrop plugin-authorization-backdrop" onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <section ref={focus.setDialog} class="modal plugin-authorization-modal" role="dialog" aria-modal="true" aria-labelledby="plugin-grants-title" tabIndex={-1} onKeyDown={focus.handleKeyDown}>
        <div class="modal-heading">
          <div><span class="modal-kicker">PLUGIN SECURITY</span><h2 id="plugin-grants-title">Granted permissions</h2></div>
          <button ref={focus.setCloseButton} type="button" class="icon-button" onClick={props.onClose} aria-label="Close granted permissions"><Icon name="close" /></button>
        </div>
        <div class="plugin-authorization-list plugin-grants-list">
          <For each={props.grants} fallback={<p class="plugin-empty">No plugin permissions have been granted.</p>}>
            {(grant) => (
              <article class="plugin-grant-row">
                <div class="plugin-grant-copy">
                  <strong>{pluginName(grant.pluginId)}</strong>
                  <span>{grant.pluginId} · v{grant.pluginVersion}</span>
                  <span class="plugin-authorization-grant-name">{pluginPermissionLabel(grant.permission)}</span>
                  <span class="plugin-authorization-detail">{scopeText(grant)}</span>
                  <span class="plugin-authorization-detail">Approved {new Date(grant.approvedAt).toLocaleString()}</span>
                </div>
                <button type="button" class="danger-button" aria-label={`Revoke ${pluginName(grant.pluginId)} ${pluginPermissionLabel(grant.permission)}`} onClick={() => props.onRevoke(grant.id)}>Revoke</button>
              </article>
            )}
          </For>
        </div>
        <div class="modal-footer"><span class="modal-footnote"><Icon name="lock" size={12} /> Revocation cancels active plugin requests</span><button type="button" class="secondary-button" onClick={props.onClose}>Done</button></div>
      </section>
    </div>
  );
}
