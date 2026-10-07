---
id: req/export-api
kind: requirement
version: 1
owner: person
title: Export API contract
---
`POST /api/exports` with the `x-harbor-viewer` header starts an export for that viewer. It responds in one of two ways:

1. `200` with `content-type: text/csv` and the file in the body.
2. `202` with JSON `{ "id": string, "status_url": string }`.
   `GET status_url` (same viewer header) returns JSON `{ "state": "queued" | "running" | "ready" | "failed", "download_url"?: string }`.
   When `state` is `ready`, `GET download_url` returns `200 text/csv` with the file.

A viewer can never read another viewer's export or job.
