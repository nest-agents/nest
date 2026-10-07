import { test } from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.ts";

const get = (path: string, viewer?: string) =>
  app.fetch(new Request(`https://harbor.test${path}`, { headers: viewer ? { "x-harbor-viewer": viewer } : {} }));

test("each viewer sees only their issues", async () => {
  const alice = (await (await get("/api/issues", "demo-alice")).json()) as { id: string }[];
  const bob = (await (await get("/api/issues", "demo-bob")).json()) as { id: string }[];
  assert.deepEqual(alice.map((i) => i.id), ["H-1", "H-2", "H-3"]);
  assert.deepEqual(bob.map((i) => i.id), ["H-3", "H-4", "H-5", "H-6"]);
});

test("internal notes never appear in the issue list", async () => {
  const body = await (await get("/api/issues", "demo-bob")).text();
  assert.ok(!body.includes("internal_notes"));
});

test("requests without a viewer are rejected", async () => {
  assert.equal((await get("/api/issues")).status, 401);
});
