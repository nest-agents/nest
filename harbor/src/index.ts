// Harbor: a small issue tracker. The viewer is chosen by the x-harbor-viewer header (demo only).

import { isViewer, issuesFor } from "./data.ts";
import { PAGE } from "./ui.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname.startsWith("/api/")) {
      const viewer = request.headers.get("x-harbor-viewer");
      if (!isViewer(viewer)) return json({ error: "Choose a viewer with the x-harbor-viewer header" }, 401);
      if (request.method === "GET" && url.pathname === "/api/issues") {
        return json(issuesFor(viewer).map(({ id, title, status, assignee }) => ({ id, title, status, assignee })));
      }
    }
    return json({ error: "Not found" }, 404);
  },
};
