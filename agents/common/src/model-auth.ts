/**
 * Model credentials come from one of two places: an `ANTHROPIC_API_KEY` (the
 * homelab path, key in a k8s Secret) or Vertex via GKE Workload Identity, where
 * there is no key at all and the SDK needs to be told which project/region to
 * call. Agents fail fast on startup rather than dying mid-turn (spec §5).
 */

/** Copied from ChatOps' own env onto the worker pods it creates. */
export const VERTEX_ENV_KEYS = [
  "CLAUDE_CODE_USE_VERTEX",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
] as const;

/**
 * Names of the model-auth env vars that are missing, in the order they should
 * be reported. Empty means the agent has usable credentials.
 */
export function missingModelAuthEnv(
  env: Record<string, string | undefined>
): string[] {
  if (env.CLAUDE_CODE_USE_VERTEX === "1") {
    // Vertex: no API key, but the region and project are not guessable.
    return ["CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID"].filter(
      (k) => !env[k]
    );
  }
  return env.ANTHROPIC_API_KEY ? [] : ["ANTHROPIC_API_KEY"];
}
