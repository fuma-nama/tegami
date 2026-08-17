import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "ini";
import { joinPath } from "../../utils/common";
import { fetchFailure } from "../../utils/error";
import type { NpmPackage } from "./graph";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/** the subset of `.npmrc` needed to reach a registry */
export interface Npmrc {
  /** `""` holds the default registry, scoped ones are keyed by `@scope` */
  registries: Map<string, string>;
  /** `//host/path/` prefix -> `Authorization` header */
  auth: Map<string, string>;
}

export async function loadNpmrc(cwd: string): Promise<Npmrc> {
  const registries = new Map<string, string>();
  const auth = new Map<string, string>();
  const userConfig =
    process.env.NPM_CONFIG_USERCONFIG ??
    process.env.npm_config_userconfig ??
    path.join(homedir(), ".npmrc");

  // the project config wins, so it is parsed last
  const contents = await Promise.all(
    [userConfig, path.join(cwd, ".npmrc")].map((file) =>
      readFile(file, "utf8").catch(() => undefined),
    ),
  );

  for (const content of contents) {
    if (!content) continue;

    for (const [key, raw] of Object.entries(parse(content))) {
      if (typeof raw !== "string") continue;

      const value = expandEnv(raw);
      if (!value) continue;

      if (key === "registry") {
        registries.set("", value);
      } else if (key.startsWith("@") && key.endsWith(":registry")) {
        registries.set(key.slice(0, -":registry".length), value);
      } else if (key.startsWith("//")) {
        const field = key.lastIndexOf(":");
        switch (key.slice(field + 1)) {
          case "_authToken":
            auth.set(withTrailingSlash(key.slice(0, field)), `Bearer ${value}`);
            break;
          case "_auth":
            auth.set(withTrailingSlash(key.slice(0, field)), `Basic ${value}`);
            break;
        }
      }
    }
  }

  return { registries, auth };
}

/** unset variables discard the entry, an empty token is worse than no header at all */
function expandEnv(value: string): string | undefined {
  let missing = false;
  const expanded = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) missing = true;
    return resolved ?? "";
  });

  return missing ? undefined : expanded;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function resolveRegistry(npmrc: Npmrc, name: string): string {
  const slash = name.indexOf("/");
  const scope = name[0] === "@" && slash > 0 ? name.slice(0, slash) : undefined;

  return (scope && npmrc.registries.get(scope)) ?? npmrc.registries.get("") ?? DEFAULT_REGISTRY;
}

/** credentials are scoped to a path prefix, `//host/a/b/` falls back to `//host/a/` then `//host/` */
export function registryAuth(npmrc: Npmrc, registry: string): string | undefined {
  const { host, pathname } = new URL(registry);
  let key = withTrailingSlash(`//${host}${pathname}`);

  while (key.length > 2) {
    const auth = npmrc.auth.get(key);
    if (auth) return auth;

    const parent = key.lastIndexOf("/", key.length - 2);
    key = parent > 1 ? key.slice(0, parent + 1) : "";
  }
}

interface Packument {
  versions?: Record<string, unknown>;
}

/**
 * Resolves to `undefined` when the package is unknown to the registry.
 *
 * GitHub Packages only implements the packument route, `GET /{name}/{version}` answers 405 there,
 * so existence is always read from the full document.
 */
export async function fetchPackument(pkg: NpmPackage): Promise<Packument | undefined> {
  const registry = pkg.getRegistry();
  const auth = registryAuth(pkg.npmrc, registry);
  const headers = new Headers({
    Accept: "application/vnd.npm.install-v1+json, application/json",
  });
  if (auth) headers.set("Authorization", auth);

  const response = await fetch(joinPath(registry, encodeURIComponent(pkg.name)), { headers });
  if (response.status === 404) return;
  if (!response.ok) {
    throw await fetchFailure(
      `Unable to read ${pkg.name} from the npm registry "${registry}"`,
      response,
    );
  }

  return response.json();
}

export async function isVersionPublished(pkg: NpmPackage, version: string): Promise<boolean> {
  const packument = await fetchPackument(pkg);
  return packument?.versions?.[version] !== undefined;
}
