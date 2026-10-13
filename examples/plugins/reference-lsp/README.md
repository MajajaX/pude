# Reference Language Server plugin

This API 2 example starts one manifest-declared language server and sends a
JSON-RPC `initialize` request through Pude's managed LSP bridge. It has no
general process-spawning API.

Before installing it, edit `plugin.json` and set `lspServers[0].executable` to
the absolute path of a trusted `rust-analyzer` executable on your machine. The
permission review resolves and displays that canonical executable path and its
`--stdio` argument. The example only starts the server when its contributed
command is run.

The command queues startup. The plugin waits for `lsp.state` to report
`started` before sending `initialize`; awaiting `pude.lsp.start()` alone does
not mean the process is ready to receive messages. It reports `startFailed`
diagnostics and listens for the matching initialize response on `lsp.message`.
Disable or uninstall the plugin to stop its managed server process.
