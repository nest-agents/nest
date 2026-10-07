import { describe, expect, it } from "vitest";
import { ArtifactsClient } from "../src/artifacts";

// Trees as the Artifacts binding returns them: immediate children only.
const trees: Record<string, { name: string; mode: string; hash: string; type: string }[]> = {
  rootA: [{ name: "src", mode: "40000", hash: "srcA", type: "tree" }, { name: "package.json", mode: "100644", hash: "p1", type: "blob" }],
  srcA: [{ name: "index.ts", mode: "100644", hash: "i1", type: "blob" }],
  rootB: [{ name: "src", mode: "40000", hash: "srcB", type: "tree" }, { name: "package.json", mode: "100644", hash: "p1", type: "blob" }, { name: "test", mode: "40000", hash: "testB", type: "tree" }],
  srcB: [{ name: "index.ts", mode: "100644", hash: "i2", type: "blob" }, { name: "csv.ts", mode: "100644", hash: "c1", type: "blob" }],
  testB: [{ name: "csv.test.ts", mode: "100644", hash: "t1", type: "blob" }],
};
const binding = { get: async () => ({ readTree: async (h: string) => trees[h] ?? null, [Symbol.dispose]() {} }) } as unknown as Artifacts;

describe("diffTrees", () => {
  it("classifies new files, including files in new directories, as adds", async () => {
    const d = await new ArtifactsClient(binding).diffTrees("r", "rootA", "rootB");
    expect(d.paths).toEqual([
      { path: "src/csv.ts", mode: "100644", change: "add" },
      { path: "src/index.ts", mode: "100644", change: "modify" },
      { path: "test/csv.test.ts", mode: "100644", change: "add" },
    ]);
  });
});
