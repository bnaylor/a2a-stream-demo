import { CoreV1Api, KubeConfig, V1Pod } from "@kubernetes/client-node";
import { VERTEX_ENV_KEYS } from "@a2a-demo/agents-common";

export interface WorkerPodSpec {
  session: string;
  taskId: string;
  correlationId: string;
  contextId: string;
}

export interface WorkerPodInfo {
  name: string;
  session: string;
  phase: string;
}

export interface PodManager {
  createWorkerPod(spec: WorkerPodSpec): Promise<void>;
  listWorkerPods(): Promise<WorkerPodInfo[]>;
  deletePod(name: string): Promise<void>;
}

export interface K8sConfig {
  namespace: string;
  image: string;
  natsUrl: string;
  secretName: string;
  /** Passed through to the worker as WORKER_MODEL when set. */
  workerModel?: string;
  /** Passed through to the worker as WORKER_MAX_BUDGET_USD when set. */
  workerMaxBudgetUsd?: string;
  /**
   * Source for PASSTHROUGH_ENV_KEYS — normally ChatOps' own `process.env`.
   * Whichever of those keys are set here are copied onto the worker pod, so a
   * ChatOps configured for Vertex spawns workers configured for Vertex.
   */
  passthroughEnv?: Record<string, string | undefined>;
}

/**
 * Env vars ChatOps copies verbatim from its own environment onto worker pods.
 * The gke overlay sets all three; the local overlay sets none, and workers fall
 * back to the ANTHROPIC_API_KEY Secret.
 */
/**
 * Copied from ChatOps' own env onto each worker pod. Vertex config, plus the
 * thinking budget so the twisties can be tuned from one deployment env var
 * rather than needing a worker image change.
 */
export const PASSTHROUGH_ENV_KEYS: readonly string[] = [
  ...VERTEX_ENV_KEYS,
  "WORKER_THINKING_BUDGET",
];

export const WORKER_APP_LABEL = "a2a-worker";
export const SESSION_LABEL = "a2a-demo/session";

/**
 * Worker pods run as this KSA. It has no Role/RoleBinding and its token is not
 * mounted (`automountServiceAccountToken: false`), so it grants no k8s API
 * access — it exists so GKE Workload Identity has something to bind a Google
 * service account to. Credentials reach the pod via the GKE metadata server.
 */
export const WORKER_SERVICE_ACCOUNT = "a2a-worker";

/**
 * Pod names are `a2a-worker-<session>`. The "worker" segment used to come from
 * the session name itself (`worker-brisk-otter`); now that sessions are bare
 * words (`otter`) it has to be spelled out here, or pods would land as
 * `a2a-otter` and stop being self-describing in `kubectl get pods`.
 */
export const workerPodName = (session: string): string => `a2a-worker-${session}`;

/** Scratch space for the worker; nothing is persisted past the pod. */
export const WORK_DIR = "/work";
const WORK_VOLUME = "work";

/**
 * Pod shape mirrors deploy/base/worker-reference.yaml (spec §4.2): no k8s API
 * access, never restarted.
 */
export function workerPodManifest(cfg: K8sConfig, spec: WorkerPodSpec): V1Pod {
  const env = [
    { name: "TASK_ID", value: spec.taskId },
    { name: "SESSION", value: spec.session },
    { name: "NATS_URL", value: cfg.natsUrl },
    { name: "CORRELATION_ID", value: spec.correlationId },
    { name: "CONTEXT_ID", value: spec.contextId },
    {
      name: "ANTHROPIC_API_KEY",
      valueFrom: {
        // optional: on GKE there is no key Secret — auth is Vertex via
        // Workload Identity, and a hard reference would wedge the pod.
        secretKeyRef: {
          name: cfg.secretName,
          key: "ANTHROPIC_API_KEY",
          optional: true,
        },
      },
    },
  ];
  if (cfg.workerModel) {
    env.push({ name: "WORKER_MODEL", value: cfg.workerModel });
  }
  if (cfg.workerMaxBudgetUsd) {
    env.push({ name: "WORKER_MAX_BUDGET_USD", value: cfg.workerMaxBudgetUsd });
  }
  for (const name of PASSTHROUGH_ENV_KEYS) {
    const value = cfg.passthroughEnv?.[name];
    if (value) env.push({ name, value });
  }

  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: workerPodName(spec.session),
      namespace: cfg.namespace,
      labels: { app: WORKER_APP_LABEL, [SESSION_LABEL]: spec.session },
    },
    spec: {
      restartPolicy: "Never",
      serviceAccountName: WORKER_SERVICE_ACCOUNT,
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000 },
      volumes: [{ name: WORK_VOLUME, emptyDir: {} }],
      containers: [
        {
          name: "worker",
          image: cfg.image,
          imagePullPolicy: "Always",
          env,
          volumeMounts: [{ name: WORK_VOLUME, mountPath: WORK_DIR }],
          resources: {
            requests: { cpu: "250m", memory: "512Mi" },
            limits: { cpu: "1", memory: "2Gi" },
          },
        },
      ],
    },
  };
}

export function makeK8sPodManager(cfg: K8sConfig): PodManager {
  const kc = new KubeConfig();
  kc.loadFromCluster();
  // @kubernetes/client-node v2 exports CoreV1Api as the object-parameter API
  // (ObjectCoreV1Api): every call takes a single named-argument object.
  const api = kc.makeApiClient(CoreV1Api);

  return {
    async createWorkerPod(spec) {
      await api.createNamespacedPod({
        namespace: cfg.namespace,
        body: workerPodManifest(cfg, spec),
      });
    },
    async listWorkerPods() {
      const list = await api.listNamespacedPod({
        namespace: cfg.namespace,
        labelSelector: `app=${WORKER_APP_LABEL}`,
      });
      return list.items.flatMap((pod) => {
        const name = pod.metadata?.name;
        if (!name) return [];
        return [
          {
            name,
            session: pod.metadata?.labels?.[SESSION_LABEL] ?? "",
            phase: pod.status?.phase ?? "Unknown",
          },
        ];
      });
    },
    async deletePod(name) {
      await api.deleteNamespacedPod({ name, namespace: cfg.namespace });
    },
  };
}
