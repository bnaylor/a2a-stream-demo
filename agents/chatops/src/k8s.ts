import { CoreV1Api, KubeConfig, V1Pod } from "@kubernetes/client-node";

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
}

export const WORKER_APP_LABEL = "a2a-worker";
export const SESSION_LABEL = "a2a-demo/session";

export const workerPodName = (session: string): string => `a2a-${session}`;

/**
 * Pod shape mirrors pre-gke/worker-reference.yaml (spec §4.2): no service
 * account, no k8s API access, never restarted.
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
        secretKeyRef: { name: cfg.secretName, key: "ANTHROPIC_API_KEY" },
      },
    },
  ];
  if (cfg.workerModel) {
    env.push({ name: "WORKER_MODEL", value: cfg.workerModel });
  }
  if (cfg.workerMaxBudgetUsd) {
    env.push({ name: "WORKER_MAX_BUDGET_USD", value: cfg.workerMaxBudgetUsd });
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
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000 },
      containers: [
        {
          name: "worker",
          image: cfg.image,
          imagePullPolicy: "Always",
          env,
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
