const commandId = "pude.example.document-case-toggle.toggleCase";

function toggleCase(text) {
  return text === text.toUpperCase() ? text.toLowerCase() : text.toUpperCase();
}

void pude.commands.register(commandId, async () => {
  const file = await pude.editor.getFileInfo();
  const text = await pude.editor.getText();

  if (text.length === 0) {
    await pude.ui.notify("The active document is empty.");
    return;
  }

  await pude.editor.applyEdits(file.revision, [
    { from: 0, to: text.length, insert: toggleCase(text) },
  ]);
  await pude.ui.notify("Document case toggled.");
});
