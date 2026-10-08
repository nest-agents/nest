import { describe, expect, test } from "vitest";
import { fileHints, rankPath } from "../src/packs";

describe("fileHints", () => {
  test("finds the files a task brief names", () => {
    const hints = fileHints("Extend packages/remeda/src/chunk.test.ts with cases. Read chunk.ts and ./README.md first; change no other file.");
    expect(hints).toEqual(["packages/remeda/src/chunk.test.ts", "chunk.ts", "README.md"]);
  });

  test("ignores prose that is not a file", () => {
    expect(fileHints("Make the badge link to the status page. Keep it under 2.5 seconds.")).toEqual([]);
  });
});

describe("rankPath", () => {
  test("mentioned files come before instructions, source, tests and the rest", () => {
    const hints = ["chunk.test.ts", "packages/remeda/src/chunk.ts"];
    const order = ["docs/guide.md", "packages/remeda/test/setup.ts", "packages/remeda/src/add.ts", "README.md", "packages/remeda/src/chunk.test.ts", "packages/remeda/src/chunk.ts"]
      .sort((a, b) => rankPath(a, hints) - rankPath(b, hints) || a.localeCompare(b));
    expect(order).toEqual([
      "packages/remeda/src/chunk.test.ts",
      "packages/remeda/src/chunk.ts",
      "README.md",
      "packages/remeda/src/add.ts",
      "packages/remeda/test/setup.ts",
      "docs/guide.md",
    ]);
  });

  test("a hint matches a whole file name, not a suffix of one", () => {
    expect(rankPath("src/unchunk.ts", ["chunk.ts"])).not.toBe(0);
    expect(rankPath("src/chunk.ts", ["chunk.ts"])).toBe(0);
  });
});
