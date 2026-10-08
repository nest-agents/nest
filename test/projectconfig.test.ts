import { describe, expect, it } from "vitest";
import { ConfigError, EMPTY_CONFIG, parseProjectConfig, previewUrl, requiredChecks } from "../src/projectconfig";

const full = JSON.stringify({
  setup: "npm ci",
  checks: [{ id: "test", run: "npm test" }, { id: "types", run: "npx tsc --noEmit", timeoutSeconds: 120 }],
  preview: { url: "https://{branch}-beacon.example.dev", path: "/status" },
  production: "https://beacon.example.dev",
  protected: ["migrations/"],
});

describe("project config", () => {
  it("is empty when the file is missing", () => {
    expect(parseProjectConfig(null)).toEqual(EMPTY_CONFIG);
  });

  it("parses setup, checks, preview, production and protected paths", () => {
    const c = parseProjectConfig(full);
    expect(c.setup).toBe("npm ci");
    expect(c.checks).toEqual([{ id: "test", run: "npm test", timeoutSeconds: 300 }, { id: "types", run: "npx tsc --noEmit", timeoutSeconds: 120 }]);
    expect(c.preview).toEqual({ url: "https://{branch}-beacon.example.dev", path: "/status" });
    expect(c.production).toBe("https://beacon.example.dev");
    expect(c.protected).toEqual(["migrations/"]);
  });

  it("rejects what it cannot trust rather than guessing", () => {
    const bad = (j: unknown) => () => parseProjectConfig(JSON.stringify(j));
    expect(() => parseProjectConfig("{not json")).toThrow(ConfigError);
    expect(bad([])).toThrow(ConfigError);
    expect(bad({ checks: [{ id: "Test", run: "x" }] })).toThrow(/lowercase/);
    expect(bad({ checks: [{ id: "t", run: "x" }, { id: "t", run: "y" }] })).toThrow(/duplicate/);
    expect(bad({ checks: [{ id: "preview", run: "x" }] })).toThrow(/reserved/);
    expect(bad({ checks: [{ id: "compose", run: "x" }] })).toThrow(/reserved/);
    expect(bad({ checks: [{ id: "t", run: "x", timeoutSeconds: 5 }] })).toThrow(/timeoutSeconds/);
    expect(bad({ checks: [{ id: "t", run: "a\u0007b" }] })).toThrow(/control/);
    expect(bad({ preview: { url: "http://{branch}.example.dev" } })).toThrow(/https/);
    expect(bad({ preview: { url: "https://preview.example.dev" } })).toThrow(/\{branch\}/);
    expect(bad({ preview: { url: "https://{branch}.example.dev", path: "status" } })).toThrow(/start with/);
    expect(bad({ checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, run: "x" })) })).toThrow(/at most 8/);
  });

  it("builds a preview URL only for branch names Nest pushes", () => {
    const c = parseProjectConfig(full);
    expect(previewUrl(c, "cand-k0123456789")).toBe("https://cand-k0123456789-beacon.example.dev/status");
    expect(previewUrl(c, "../evil")).toBeNull();
    expect(previewUrl(c, "Cand-K1")).toBeNull();
    expect(previewUrl(EMPTY_CONFIG, "cand-k0123456789")).toBeNull();
  });

  it("requires a clean composition, the project's checks and its preview", () => {
    expect(requiredChecks(parseProjectConfig(full))).toEqual(["compose", "test", "types", "preview"]);
    expect(requiredChecks(EMPTY_CONFIG)).toEqual(["compose"]);
  });
});
