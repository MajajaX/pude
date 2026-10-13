const serverId = "rust-analyzer";
const commandId = "pude.example.reference-lsp.start";
const initializeRequestId = "pude-reference-lsp-initialize";

void pude.events.on("lsp.message", async (event) => {
  if (event.serverId !== serverId || event.message.id !== initializeRequestId) return;
  if (event.message.error) {
    await pude.ui.notify("rust-analyzer initialization failed.");
    return;
  }
  await pude.ui.notify("rust-analyzer is ready.");
});

void pude.events.on("lsp.state", async (event) => {
  if (event.serverId !== serverId) return;
  if (event.state === "startFailed") {
    await pude.ui.notify(event.message || "rust-analyzer could not start.");
    return;
  }
  if (event.state !== "started") return;
  await pude.lsp.send(serverId, {
    jsonrpc: "2.0",
    id: initializeRequestId,
    method: "initialize",
    params: {
      processId: null,
      rootUri: null,
      capabilities: {},
    },
  });
});

void pude.commands.register(commandId, async () => {
  await pude.lsp.start(serverId);
});
