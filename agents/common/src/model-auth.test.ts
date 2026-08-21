import { describe, expect, it } from "vitest";
import { missingModelAuthEnv } from "./model-auth.ts";

describe("missingModelAuthEnv", () => {
  it("accepts an API key", () => {
    expect(missingModelAuthEnv({ ANTHROPIC_API_KEY: "sk-test" })).toEqual([]);
  });

  it("requires an API key when Vertex is off", () => {
    expect(missingModelAuthEnv({})).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("does not require an API key under Vertex", () => {
    expect(
      missingModelAuthEnv({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "us-east5",
        ANTHROPIC_VERTEX_PROJECT_ID: "bnaylor-kagents-dev",
      })
    ).toEqual([]);
  });

  it("requires region and project under Vertex", () => {
    expect(missingModelAuthEnv({ CLAUDE_CODE_USE_VERTEX: "1" })).toEqual([
      "CLOUD_ML_REGION",
      "ANTHROPIC_VERTEX_PROJECT_ID",
    ]);
  });

  it("reports only the missing half of the Vertex config", () => {
    expect(
      missingModelAuthEnv({
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "us-east5",
      })
    ).toEqual(["ANTHROPIC_VERTEX_PROJECT_ID"]);
  });

  it("only treats the literal \"1\" as Vertex enablement", () => {
    expect(missingModelAuthEnv({ CLAUDE_CODE_USE_VERTEX: "true" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });
});
