import z from "zod";

const cargoDependencySchema = z.union([
  z.string(),
  z.object({
    version: z.string(),
    package: z.string().optional(),
    path: z.string().optional(),
  }),
]);

const cargoTargetConfigSchema = z.object({
  dependencies: z.record(z.string(), cargoDependencySchema).optional(),
  "dev-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  "build-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
});

const cargoPackageSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  publish: z.boolean().optional(),
});

const cargoWorkspaceSchema = z.object({
  members: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  package: z
    .object({
      version: z.string().optional(),
    })
    .optional(),
});

export const cargoManifestSchema = z.object({
  package: cargoPackageSchema,
  workspace: cargoWorkspaceSchema.optional(),
  dependencies: z.record(z.string(), cargoDependencySchema).optional(),
  "dev-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  "build-dependencies": z.record(z.string(), cargoDependencySchema).optional(),
  target: z.record(z.string(), cargoTargetConfigSchema).optional(),
});

export type CargoDependency = z.infer<typeof cargoDependencySchema>;
export type CargoManifest = z.infer<typeof cargoManifestSchema>;
