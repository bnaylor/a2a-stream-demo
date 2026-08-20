import { connect } from "nats";
import { describe, expect, it } from "vitest";
import { STREAM_NAME, ensureStream } from "./stream.ts";

const url = process.env.NATS_URL;

describe.skipIf(!url)("ensureStream (requires NATS_URL)", () => {
  it("creates the A2A stream idempotently with spec config", async () => {
    const nc = await connect({ servers: url });
    try {
      const jsm = await nc.jetstreamManager();
      await ensureStream(jsm);
      await ensureStream(jsm); // idempotent
      const info = await jsm.streams.info(STREAM_NAME);
      expect(info.config.subjects).toEqual(["a2a.>"]);
      expect(info.config.max_bytes).toBe(256 * 1024 * 1024);
      expect(info.config.max_age).toBe(24 * 60 * 60 * 1_000_000_000);
      expect(info.config.storage).toBe("file");
    } finally {
      await nc.close();
    }
  });
});
