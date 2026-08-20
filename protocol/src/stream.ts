import { JetStreamManager, RetentionPolicy, StorageType, StreamConfig } from "nats";

export const STREAM_NAME = "A2A";

const CONFIG: Partial<StreamConfig> = {
  name: STREAM_NAME,
  subjects: ["a2a.>"],
  storage: StorageType.File,
  retention: RetentionPolicy.Limits,
  max_age: 24 * 60 * 60 * 1_000_000_000, // 24 h in ns
  max_bytes: 256 * 1024 * 1024,
};

export async function ensureStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, CONFIG);
  } catch {
    await jsm.streams.add(CONFIG);
  }
}
