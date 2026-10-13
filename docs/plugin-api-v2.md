# pude Plugin API 2

This guide describes local plugins built for API 2. The runnable example in [`examples/plugins/document-case-toggle`](../examples/plugins/document-case-toggle) toggles the active document between uppercase and lowercase. It has no package dependencies, so you can install it repeatedly from its folder while developing.

Plugins are code you choose to trust. Read the plugin section of
[SECURITY.md](../SECURITY.md) before installing or publishing one.

## Package layout

```text
my-plugin/
├── plugin.json
└── extension.js
```

The app reads `plugin.json`, copies the package into its application data directory, and loads only the declared `entry` file. Packages must contain regular files and directories; symbolic links are rejected. Keep executable plugin code in a local folder you trust.

Every manifest needs a stable `id`, a `name`, a `version`, `apiVersion: "2"`, an `entry`, a `permissions` array, and `activationEvents`. Commands also appear in `contributes.commands`:

```json
{
  "id": "pude.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "apiVersion": "2",
  "entry": "extension.js",
  "permissions": ["commands.register", "ui.notification"],
  "activationEvents": ["onCommand:pude.example.hello.run"],
  "contributes": {
    "commands": [
      { "command": "pude.example.hello.run", "title": "Say Hello" }
    ]
  }
}
```

Each contributed command ID must be unique within the manifest and have a matching `onCommand:<id>` activation event. Command IDs and language IDs use letters, digits, `.`, `_`, or `-`; IDs begin with a letter or digit. Other supported activation events are `onLanguage:<languageId>`, `onFileOpen`, `onFileSave`, and `onWorkspaceOpen`.

## Install and iterate

1. Open **Plugins** in pude and choose **Install local plugin**.
2. Select the plugin folder. The app validates the manifest and package, then stages a copy for review.
3. Review the requested permissions and approve only those the plugin needs. API 1 legacy facade capabilities and API 2 host calls both use these saved grants; editor text is supplied to API 1 only when `editor.read` is approved. **Cancel** declines the install or update and preserves the current version and grants. Approving with no permissions selected installs the proposed version with every permission denied.
4. Enable the plugin. Search for its contributed title in the command palette and run it.
5. Edit the source folder, choose **Update from folder** on the installed plugin, select the folder again, and review the proposed version and permission changes. The update replaces the installed copy only after approval; a failed replacement restores the previous copy.
6. Disable or uninstall the plugin from **Plugins**. Uninstall stops its worker and revokes its grants before removing its app data. If file cleanup is incomplete, use **Retry cleanup** in the Plugins view.

The example command is repeatable: run **Toggle Document Case** to uppercase the active text, then run it again to lowercase it. It uses a full-document range edit so the result follows the editor's normal dirty, undo, and save behavior.

## Runtime model

API 2 code runs in a Web Worker created from an opaque-origin sandbox document. A plugin does not receive the editor's DOM, CodeMirror objects, Tauri API, or host browser storage. The only host connection is a request/reply message protocol with `protocolVersion: 2`, parameter validation, and structured errors.

The Worker exposes the `pude` facade. Plugin code runs once to register command handlers and event subscriptions; command handlers run when a command is invoked. API 2 calls are asynchronous and return promises. The facade generates increasing request IDs; hosts retain only in-flight IDs, reject a duplicate while it is pending, and release the ID when the response finishes. A custom protocol client may reuse an ID after it has received that response, but must not reuse an ID while the earlier call is pending. Each run allows up to 512 concurrent API requests, 20 requests per rolling second, a 30-second execution timeout, 64 KiB request messages, and 1 MiB response messages. Stopping or disabling a plugin cancels its outstanding requests and disposes its Worker.

## API reference

Each call requires the corresponding permission in `plugin.json` and a matching user grant for the plugin version, workspace, and any declared resource scope. A manifest declaration alone does not grant access. A denied or stale request rejects with an error object containing a stable `code`, a human-readable `message`, and a `retryable` flag.

| API call | Permission | Result and limits |
| --- | --- | --- |
| `pude.editor.getText()` | `editor.read` | Text of the active document when it fits in one response (up to 128 Ki UTF-16 code units). Larger documents return `editor.range_required`; use the revision-bound range method. |
| `pude.editor.getTextRange(revision, from, to)` | `editor.read` | Returns `{revision, from, to, content}` for the active document at the revision returned by `getFileInfo()`. `from` and `to` are UTF-16 code-unit offsets; one call is limited to 128 Ki code units. A stale document or revision returns `editor.stale_revision`. Concatenate adjacent ranges to read a larger document. |
| `pude.editor.getSelection()` | `editor.read` | Active selection range and selected text. |
| `pude.editor.getCursor()` | `editor.read` | Active cursor location. |
| `pude.editor.getFileInfo()` | `editor.read` | Path, name, language, revision, dirty state, encoding, line ending, and estimated serialized file size in bytes. Range offsets use UTF-16 code units, not this size estimate. |
| `pude.editor.applyEdits(revision, edits)` | `editor.write` | Applies at most 1,000 `{from, to, insert}` edits to the active document if its revision still matches. Offsets are UTF-16 code-unit positions in the text read for that revision. Each request must fit the 64 KiB request budget; split large updates into bounded calls and use each returned revision for the next call. Edits become normal editor changes and do not write directly to disk. |
| `pude.workspace.list({path?})` | `workspace.read` | Lists entries under the current workspace; paths are relative and traversal is rejected. |
| `pude.workspace.readFile({path})` | `workspace.read` | Reads a whole file in one response when its on-disk size is at most 128 KiB. Larger files return `workspace.file_requires_ranges`; use `getFileInfo()` and `readFileRange()`. |
| `pude.workspace.getFileInfo({path})` | `workspace.read` | Returns `{path, revision, sizeBytes}`. `sizeBytes` is raw on-disk size, read from metadata only; use it to check size before reading. No file content snapshot is allocated. |
| `pude.workspace.readFileRange({path, revision, offsetBytes, maxBytes})` | `workspace.read` | Returns `{path, revision, offsetBytes, nextOffsetBytes, totalBytes, content, eof}` with up to 128 KiB of normalized file text. Files over 20 MiB return `workspace.file_too_large` before a content snapshot is allocated. Offsets, `totalBytes`, and lengths are UTF-8 bytes in the logical text, which has a UTF-8 BOM removed and CRLF normalized to LF. Returned ranges begin and end at UTF-8 boundaries; concatenate `content` in order until `eof`. A changed file returns `workspace.file_changed`. |
| `pude.workspace.releaseFileRead({path, revision})` | `workspace.read` | Returns `{released: true}` and releases a partial range snapshot when a reader stops before EOF. EOF also releases it automatically. |
| `pude.workspace.writeFile({path, content, expectedFingerprint?})` | `workspace.write` | Creates or conflict-checks and modifies a file within the workspace. One call is limited by the 64 KiB request-message budget, including the path and protocol envelope; larger file writes are not supported by this method. It does not delete files. |
| `pude.commands.register(id, handler)` | `commands.register` | Registers a command declared in `contributes.commands`. |
| `pude.events.on(event, handler)` | No separate permission | Subscribes to an event declared in `activationEvents`; its unsubscribe function ends the subscription. The LSP runtime events below are authorized by the server declaration and grant instead. |
| `pude.ui.notify(message)` | `ui.notification` | Shows a host notification with bounded text. |
| `pude.ui.statusBar.set(id, text, tooltip?)` / `remove(id)` | `ui.statusBar` | Adds, updates, or removes a host-rendered item. IDs are limited to 64 characters, text to 120, and optional tooltips to 256. Disable removes the plugin's items. |
| `pude.ui.quickPick({items, placeholder?})` | `ui.quickPick` | Shows a bounded host-rendered option list and returns the selected item or `null`. |
| `pude.git.getStatus()` | `git.read` | Reads branch and status for the current repository. |
| `pude.git.getDiff({path, staged?})` | `git.read` | Reads a bounded diff for a workspace-relative path. |
| `pude.terminal.write({data})` | `terminal.write` | Writes to a terminal the user already opened; it cannot create a shell. |
| `pude.network.fetch({url, method?, headers?, body?})` | `network` | HTTPS requests to an exact `networkDomains` host through the host proxy, after workspace- and domain-scoped approval. Redirect destinations are checked again. |
| `pude.lsp.start(serverId)` | `process.spawn:lsp` | Queues startup of a manifest-declared server through the restricted Rust LSP manager after approval of its resolved executable and arguments for the current workspace. Awaiting this call does not mean the server is ready; wait for its `lsp.state` event with `state: "started"` before sending messages. No general process spawning is available. |
| `pude.lsp.send(serverId, message)` | `process.spawn:lsp` | Sends one JSON-RPC 2.0 message to the declared server within the 64 KiB request budget. Large document synchronization must use incremental, range-based LSP changes in bounded messages. |
| `pude.lsp.cancel(serverId, requestId)` | `process.spawn:lsp` | Cancels an outstanding request for that server. |
| `pude.lsp.stop(serverId)` | `process.spawn:lsp` | Stops the server for this plugin and workspace. |
| `pude.events.on("lsp.message", handler)`; `pude.events.on("lsp.state", handler)`; `pude.events.on("lsp.stderr", handler)` | `process.spawn:lsp` | Receives messages, lifecycle state, or bounded stderr text only for the plugin's declared and approved server in the current workspace. These runtime subscriptions do not need entries in `activationEvents`. |

Workspace paths use `/` separators and cannot be absolute or contain `..`. The host canonicalizes paths and rejects symlink traversal. Message size is measured by a bounded JSON-like tree walk: strings and keys use UTF-8 byte length plus quote/key punctuation; arrays and objects include delimiters and commas; numbers use their string form. The check also limits node count and nesting depth. It avoids building a second serialized copy and is not an exact `JSON.stringify` byte count because JSON escaping can expand some characters. Range sizes leave enough room for worst-case escaping and envelope fields. Requests are not retained after completion; the fixed 512-call in-flight cap bounds tracking and concurrent work.

Subscribe to `lsp.state` before calling `lsp.start`. For the expected `serverId`, send initialization after `state: "started"`, and handle `state: "startFailed"` as a startup failure. Startup runs asynchronously with a bounded native deadline; sending immediately after `await pude.lsp.start(...)` can reject while the server is still starting. The [reference LSP plugin](../examples/plugins/reference-lsp/README.md) demonstrates this event sequence. Lifecycle and response events are routed only to the current authorized plugin version and workspace activation.

To read a workspace file incrementally, keep the opaque revision from `getFileInfo`, then advance using each range's `nextOffsetBytes`. The `content` in a result is UTF-8 text and may contain fewer bytes than `maxBytes` when the end of a chunk must be moved to a character boundary. `sizeBytes` is the raw disk size; `totalBytes` is the normalized text length in UTF-8 bytes.

```js
const path = "src/main.rs";
const info = await pude.workspace.getFileInfo({ path });
const chunks = [];
let offsetBytes = 0;
try {
  while (true) {
    const range = await pude.workspace.readFileRange({
      path,
      revision: info.revision,
      offsetBytes,
      maxBytes: 128 * 1024,
    });
    chunks.push(range.content);
    offsetBytes = range.nextOffsetBytes;
    if (range.eof) break;
  }
} finally {
  await pude.workspace.releaseFileRead({ path, revision: info.revision }).catch(() => undefined);
}
const text = chunks.join("");
```

Each snapshot is immutable for its revision and disk changes reject subsequent ranges rather than mixing versions. The host/native cache holds at most two snapshots and 32 MiB; EOF, an explicit release, or cache eviction frees a snapshot. If a run is cancelled while a native range is in progress, the host abort signal cancels that bounded native operation. A reader that deliberately stops between calls should call `releaseFileRead` as shown.

## Update and permission behavior

The app validates the staged manifest before showing the review. For an update, it compares the old and proposed permission declarations, version, network domains, and LSP server executables. The user approves the new version before the app swaps the staged directory into place. Canceling the review keeps the installed version and its grants unchanged. Approving a restricted grant set replaces all saved grants for that plugin, including older versions, with only the selected new-version grants. Approving an empty set or a package with no permissions clears that plugin's prior grants. Other plugins' grants remain unchanged. If saving the replacement grants fails, the prior grants are preserved and the package is rolled back. The app keeps the previous package as rollback data and restores it if a replacement fails.

Grants are version-bound. Workspace access is scoped to the selected workspace; each network grant is scoped to an exact HTTPS domain, and each LSP grant is scoped to the declared executable and arguments. API 1 exposes only its legacy editor, command, notification, and status bar facade capabilities, and the host supplies only those approved at startup. Revoking a grant stops active runs so the facade is rebuilt on the next activation. At startup, the host restores a validated previous version if an update was interrupted between the two directory renames. A pending uninstall stays hidden until its cleanup is retried. Disabling a plugin stops its worker; uninstall revokes its grants and removes plugin data from the app data directory. Incomplete filesystem cleanup can be retried.

Plugins are executable local code. Install only packages whose source you trust, and review permission requests and updates before approval.
