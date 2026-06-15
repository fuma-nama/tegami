import { z } from "zod";

export const changelogFrontmatterSchema = z.object({
  subject: z.string().optional(),
  packages: z.array(z.string()).default([]),
});

const stringRecordSchema = z.record(z.string(), z.string());

export const jsonCodec = <T extends z.core.$ZodType>(schema: T) =>
  z.codec(z.string(), schema, {
    decode: (jsonString, ctx) => {
      try {
        return JSON.parse(jsonString);
      } catch (err: any) {
        ctx.issues.push({
          code: "invalid_format",
          format: "json",
          input: jsonString,
          message: err.message,
        });
        return z.NEVER;
      }
    },
    encode: (value) => JSON.stringify(value),
  });

export const pnpmWorkspaceSchema = z.looseObject({
  packages: z.array(z.string()).optional(),
});

// must not have any asymmetric properties, because we directly return the original object, this is only for validation to preserve key order
export const packageManifestSchema = z.looseObject({
  name: z.string(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  publishConfig: z
    .looseObject({
      access: z.enum(["public", "restricted"]).optional(),
      registry: z.string().optional(),
      tag: z.string().optional(),
    })
    .optional(),
  workspaces: z.array(z.string()).optional(),
  dependencies: stringRecordSchema.optional(),
  devDependencies: stringRecordSchema.optional(),
  peerDependencies: stringRecordSchema.optional(),
  optionalDependencies: stringRecordSchema.optional(),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;
