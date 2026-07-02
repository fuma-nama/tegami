import z from "zod";

const baseDepSchema = z.object({
  package: z.string().optional(),
  features: z.array(z.string()).optional(),
  optional: z.boolean().optional(),
  "default-features": z.boolean().optional(),
});

/** `{ workspace = true }` — inherit from `[workspace.dependencies]` */
const workspaceDependencySchema = baseDepSchema.extend({
  workspace: z.literal(true),
});

/** `{ path = "../lib" }` — optional `version` for publishing */
const pathDependencySchema = baseDepSchema.extend({
  path: z.string(),
  version: z.string().optional(),
});

/** `{ git = "…" }` — exactly one of `branch`, `tag`, or `rev` in practice */
const gitDependencySchema = baseDepSchema.extend({
  git: z.string(),
  branch: z.string().optional(),
  tag: z.string().optional(),
  rev: z.string().optional(),
  version: z.string().optional(),
});

/** `{ version = "1.0" }` — crates.io or `[registries]` */
const registryDependencySchema = baseDepSchema.extend({
  version: z.string(),
  registry: z.string().optional(),
});

/**
 * @see https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html
 */
const cargoDependencySchema = z.union([
  z.string(),
  workspaceDependencySchema,
  pathDependencySchema,
  gitDependencySchema,
  registryDependencySchema,
]);

const cargoInheritSchema = z.looseObject({
  workspace: z.literal(true),
});

const cargoWorkspaceSchema = z.looseObject({
  members: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  package: z
    .looseObject({
      version: z.string().optional(),
      publish: z.boolean().optional(),
    })
    .optional(),
  dependencies: z.record(z.string(), cargoDependencySchema).optional(),
  "dev-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  "build-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
});

export const cargoManifestSchema = z.looseObject({
  package: z
    .looseObject({
      name: z.string(),
      version: z.string().or(cargoInheritSchema),
      publish: z.boolean().or(cargoInheritSchema).optional(),
    })
    .optional(),
  workspace: cargoWorkspaceSchema.optional(),
  dependencies: z.record(z.string(), cargoDependencySchema).optional(),
  "dev-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  "build-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  target: z
    .record(
      z.string(),
      z.looseObject({
        dependencies: z.record(z.string(), cargoDependencySchema).optional(),
        "dev-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
        "build-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
      }),
    )
    .optional(),
});

export type CargoDependency = z.infer<typeof cargoDependencySchema>;
export type CargoManifest = z.infer<typeof cargoManifestSchema>;
