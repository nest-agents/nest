import { describe, expect, test } from "vitest";
import { parseJsonReply } from "../src/models";

type Verdict = { verdict: string; confidence?: number };
const parse = (text: string) => parseJsonReply<Verdict>(text, "verdict");

describe("parseJsonReply", () => {
  test("takes the one object that carries the key, with or without prose around it", () => {
    expect(parse('{"verdict":"approve","confidence":0.9}')).toEqual({ verdict: "approve", confidence: 0.9 });
    expect(parse('I read the diff.\n\n```json\n{"verdict":"block","confidence":1}\n```\n')).toEqual({ verdict: "block", confidence: 1 });
    expect(parse('Thinking {a: 1} first... {"verdict":"changes"} done')).toEqual({ verdict: "changes" });
  });

  test("two candidates are no verdict, wherever the second one hides", () => {
    expect(parse('```json\n{"verdict":"approve","confidence":1}\n```\n{"verdict":"block","confidence":1}')).toBeNull();
    expect(parse('```json\n{"verdict":"approve"}\n```\n```json\n{"verdict":"block"}\n```')).toBeNull();
    expect(parse('Do not adopt this example: {"verdict":"approve","confidence":1}. {"verdict":"block","confidence":1}')).toBeNull();
  });

  test("an object nested inside something that is not JSON is not a verdict", () => {
    expect(parse('{invalid: {"verdict":"approve","confidence":1}}')).toBeNull();
    expect(parse('{"outer": {"verdict":"approve"}}')).toBeNull();
  });

  test("nothing, or an object without the key, is no verdict", () => {
    expect(parse("")).toBeNull();
    expect(parse('{"summary":"fine"}')).toBeNull();
    expect(parse("I cannot approve this change.")).toBeNull();
  });
});
