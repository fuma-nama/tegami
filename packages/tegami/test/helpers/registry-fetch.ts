import { vi } from "vitest";

export const fetchMock = vi.fn<typeof fetch>();

export const PACKUMENT_ACCEPT = "application/vnd.npm.install-v1+json, application/json";

export function fetchedRequests(mock: { mock: { calls: Parameters<typeof fetch>[] } } = fetchMock) {
  return mock.mock.calls.map(([input, init]) => ({
    url: String(input),
    headers: Object.fromEntries(new Headers(init?.headers)),
  }));
}

export function npmPackumentUrl(registry: string | undefined, name: string): string {
  const base = (registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  return `${base}/${encodeURIComponent(name)}`;
}

export function installRegistryFetchMock(defaultStatus = 404) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("Not found", { status: defaultStatus }));
  vi.stubGlobal("fetch", fetchMock);
}

/** a response body can only be read once, so every call gets a fresh packument */
export function mockRegistryPublished(versions = ["1.0.1"]) {
  const body = JSON.stringify({ versions: Object.fromEntries(versions.map((v) => [v, {}])) });
  fetchMock.mockImplementation(async () => new Response(body, { status: 200 }));
}

export function mockRegistryMissing() {
  fetchMock.mockImplementation(async () => new Response("Not found", { status: 404 }));
}

export function uninstallRegistryFetchMock() {
  vi.unstubAllGlobals();
}
