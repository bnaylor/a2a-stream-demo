/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { wsUrl } from "./config.ts";

const at = (href: string): void => {
  window.history.replaceState({}, "", href);
};

afterEach(() => at("/"));

describe("wsUrl", () => {
  it("defaults to same-origin /ws", () => {
    at("/");
    // jsdom serves http://localhost:3000 by default.
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws`);
  });

  it("keeps the port in the host", () => {
    expect(wsUrl()).toContain(`//${window.location.host}/`);
    expect(window.location.host).toContain(":");
  });

  it("uses wss when the page is https", () => {
    // jsdom won't navigate across schemes, so stub the protocol.
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "https:", host: "demo.example:443", search: "" },
    });
    try {
      expect(wsUrl()).toBe("wss://demo.example:443/ws");
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  it("honours the ?ws= override", () => {
    at("/?ws=ws://127.0.0.1:9222");
    expect(wsUrl()).toBe("ws://127.0.0.1:9222");
  });

  it("honours a ?ws= override pointing at a NodePort", () => {
    at("/?ws=ws://10.3.10.3:30222");
    expect(wsUrl()).toBe("ws://10.3.10.3:30222");
  });
});
