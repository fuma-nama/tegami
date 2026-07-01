import z from "zod";

const uvSourceSchema = z.object({
  workspace: z.boolean().optional(),
  path: z.string().optional(),
});

const uvIndexSchema = z.object({
  name: z.string(),
  url: z.string(),
  "publish-url": z.string().optional(),
});

const uvSchema = z.object({
  workspace: z
    .object({
      members: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  sources: z.record(z.string(), uvSourceSchema).optional(),
  index: z.array(uvIndexSchema).optional(),
});

const pyprojectProjectSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  dependencies: z.array(z.string()).optional(),
  "optional-dependencies": z.record(z.string(), z.array(z.string())).optional(),
});

export const pyprojectManifestSchema = z.object({
  project: pyprojectProjectSchema.optional(),
  "dependency-groups": z.record(z.string(), z.array(z.string())).optional(),
  tool: z
    .object({
      uv: uvSchema.optional(),
    })
    .optional(),
});

export type PyprojectManifest = z.infer<typeof pyprojectManifestSchema>;
export type UvIndex = z.infer<typeof uvIndexSchema>;
export type UvSource = z.infer<typeof uvSourceSchema>;

export const simpleIndexProjectSchema = z.object({
  files: z.array(z.object({ filename: z.string() })).optional(),
});
