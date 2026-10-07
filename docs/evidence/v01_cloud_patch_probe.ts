// Reproduces the v0.1 cloud composition defect. Run from ~/nest: ./node_modules/.bin/tsx ../nest-v1/docs/evidence/v01_cloud_patch_probe.ts

import { normalizedPatch, applyPatch } from "../../../nest/apps/worker/delta.ts";
const before = { "src/a.ts": "line1\nline2\nline3\nline4\nline5\n" };
const c1 = normalizedPatch(before, { "src/a.ts": "LINE1-by-agent-1\nline2\nline3\nline4\nline5\n" });
const c2 = normalizedPatch(before, { "src/a.ts": "line1\nline2\nline3\nline4\nLINE5-by-agent-2\n" });
console.log("c1 patch:\n" + c1.patch);
const afterC1 = applyPatch(before, c1.patch);
console.log("after c1 OK:", JSON.stringify(afterC1["src/a.ts"]));
try { const both = applyPatch(afterC1, c2.patch); console.log("after c2 OK:", JSON.stringify(both["src/a.ts"])); }
catch (e) { console.log("CLOUD composition of c1+c2 ->", (e as Error).message); }
