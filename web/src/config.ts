export function wsUrl(): string {
  const param = new URLSearchParams(window.location.search).get("ws");
  return param ?? `ws://${window.location.hostname}:30222`;
}
