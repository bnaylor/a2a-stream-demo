import { describe, expect, it } from "vitest";
import {
  K8sConfig,
  WORKER_SERVICE_ACCOUNT,
  workerPodManifest,
  WorkerPodSpec,
} from "./k8s.ts";

const cfg: K8sConfig = {
  namespace: "a2a-demo",
  image: "reg/a2a-demo/worker:latest",
  natsUrl: "nats://nats:4222",
  secretName: "a2a-demo-secrets",
};

const spec: WorkerPodSpec = {
  session: "otter",
  taskId: "task-1",
  correlationId: "corr-1",
  contextId: "ctx-1",
};

const envOf = (pod: ReturnType<typeof workerPodManifest>) =>
  Object.fromEntries(
    (pod.spec?.containers[0]?.env ?? []).map((e) => [e.name, e.value])
  );

describe("workerPodManifest", () => {
  it("runs workers under the a2a-worker service account without a token", () => {
    const pod = workerPodManifest(cfg, spec);
    expect(pod.spec?.serviceAccountName).toBe(WORKER_SERVICE_ACCOUNT);
    expect(WORKER_SERVICE_ACCOUNT).toBe("a2a-worker");
    // Workload Identity flows through the GKE metadata server, so the pod
    // still gets no k8s API credentials.
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
  });

  it("marks the API key secret optional (no such Secret on GKE)", () => {
    const pod = workerPodManifest(cfg, spec);
    const key = pod.spec?.containers[0]?.env?.find(
      (e) => e.name === "ANTHROPIC_API_KEY"
    );
    expect(key?.valueFrom?.secretKeyRef).toMatchObject({
      name: "a2a-demo-secrets",
      key: "ANTHROPIC_API_KEY",
      optional: true,
    });
  });

  it("passes Vertex config through to the worker when ChatOps has it", () => {
    const pod = workerPodManifest(
      {
        ...cfg,
        passthroughEnv: {
          CLAUDE_CODE_USE_VERTEX: "1",
          CLOUD_ML_REGION: "us-east5",
          ANTHROPIC_VERTEX_PROJECT_ID: "bnaylor-kagents-dev",
          SOMETHING_ELSE: "not-copied",
        },
      },
      spec
    );
    const env = envOf(pod);
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(env.CLOUD_ML_REGION).toBe("us-east5");
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("bnaylor-kagents-dev");
    expect(env).not.toHaveProperty("SOMETHING_ELSE");
  });

  it("omits Vertex env entirely when ChatOps is on the API-key path", () => {
    const env = envOf(workerPodManifest({ ...cfg, passthroughEnv: {} }, spec));
    expect(env).not.toHaveProperty("CLAUDE_CODE_USE_VERTEX");
    expect(env).not.toHaveProperty("CLOUD_ML_REGION");
    expect(env).not.toHaveProperty("ANTHROPIC_VERTEX_PROJECT_ID");
  });
});
