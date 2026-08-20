/**
 * WebSocket endpoint for the NATS connection.
 *
 * Default is same-origin `/ws`, which the web pod's nginx proxies to the
 * nats-ws Service (see web/nginx.conf). That keeps the UI on one port, follows
 * the page's scheme so TLS deployments don't hit mixed content, and — on GKE —
 * inherits the page's basic auth on the upgrade request.
 *
 * `?ws=` overrides it: required for `npm run -w web dev` (the Vite dev server
 * has no proxy), and handy for pointing a dev browser at a cluster's nats-ws
 * NodePort directly.
 */
export function wsUrl(): string {
  const param = new URLSearchParams(window.location.search).get("ws");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return param ?? `${scheme}://${window.location.host}/ws`;
}
