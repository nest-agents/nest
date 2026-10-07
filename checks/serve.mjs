// Trusted server that hosts a candidate Worker module over plain HTTP inside its container.
// Checks and previews call it from outside the container; nothing here decides a verdict.
//
//   node serve.mjs <candidate-dir> [port]

import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, portText] = process.argv.slice(2);
const port = Number(portText ?? 8080);
let app;
let loadError;
try {
  app = (await import(pathToFileURL(join(dir, "src/index.ts")).href)).default;
  if (typeof app?.fetch !== "function") throw new Error("src/index.ts must default-export { fetch }");
} catch (e) {
  loadError = e instanceof Error ? e.message : String(e);
}

createServer(async (req, res) => {
  if (req.url === "/__nest/health") {
    res.writeHead(loadError ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(loadError ? { ok: false, error: loadError } : { ok: true }));
    return;
  }
  if (loadError) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Candidate failed to load: ${loadError}`);
    return;
  }
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const request = new Request(new URL(req.url ?? "/", "http://harbor.preview"), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const response = await app.fetch(request, {}, { waitUntil() {}, passThroughOnException() {} });
    const out = Buffer.from(await response.arrayBuffer());
    const h = {};
    response.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
    res.writeHead(response.status, h);
    res.end(out);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Candidate threw: ${e instanceof Error ? e.message : String(e)}`);
  }
}).listen(port, "0.0.0.0");
