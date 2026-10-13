import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "vite";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const url = "http://localhost:5173/";

let existingResponse;
try {
  existingResponse = await fetch(url, { signal: AbortSignal.timeout(800) });
} catch {
  existingResponse = undefined;
}

if (existingResponse) {
  const html = await existingResponse.text();
  if (!html.includes("<title>pude — pure code editor</title>") || !html.includes("/@vite/client")) {
    throw new Error("Port 5173 is occupied by another server. Stop it before starting pude.");
  }
  console.log("Using the existing pude Vite server at http://localhost:5173/");
} else {
  const server = await createServer({ root: projectRoot, configFile: resolve(projectRoot, "vite.config.ts") });
  await server.listen();
  server.printUrls();
}
