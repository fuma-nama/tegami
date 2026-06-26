import { vi } from "vitest";

export const fetchMock = vi.fn<typeof fetch>();

export function npmPackageVersionUrl(
  registry: string | undefined,
  name: string,
  version: string,
): string {
  const base = (registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  return `${base}/${name}/${version}`;
}

export function installRegistryFetchMock(defaultStatus = 404) {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("Not found", { status: defaultStatus }));
  vi.stubGlobal("fetch", fetchMock);
}

export function mockRegistryPublished(body = JSON.stringify({ version: "1.0.1" })) {
  fetchMock.mockResolvedValue(new Response(body, { status: 200 }));
}

export function mockRegistryMissing() {
  fetchMock.mockResolvedValue(new Response("Not found", { status: 404 }));
}

export function uninstallRegistryFetchMock() {
  vi.unstubAllGlobals();
}
