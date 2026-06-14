import { z } from "zod";

export const changelogFrontmatterSchema = z.object({
  subject: z.string().optional(),
  packages: z.array(z.string()).default([]),
});

const stringRecordSchema = z.record(z.string(), z.string());

const jsonCodec = <T extends z.core.$ZodType>(schema: T) =>
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

export const workspacePatternsSchema = z
  .union([
    z.array(z.string()),
    z
      .looseObject({
        packages: z.array(z.string()).optional(),
      })
      .transform((workspaces) => workspaces.packages ?? ["."]),
  ])
  .pipe(z.array(z.string()));

export const packageManifestSchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  private: z.boolean().optional(),
  publishConfig: z
    .looseObject({
      access: z.enum(["public", "restricted"]).optional(),
      registry: z.string().optional(),
      tag: z.string().optional(),
    })
    .optional(),
  workspaces: workspacePatternsSchema.optional(),
  dependencies: stringRecordSchema.optional(),
  devDependencies: stringRecordSchema.optional(),
  peerDependencies: stringRecordSchema.optional(),
  optionalDependencies: stringRecordSchema.optional(),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;

/** the persisted plan data for actual publishing */
export const planStoreSchema = jsonCodec(
  z.object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    /** release note entries */
    changelogs: z.record(
      z.string(),
      z.object({
        filename: z.string(),
        subject: z.string().optional(),
        packages: z.array(z.string()),
        type: z.enum(["major", "minor", "patch"]),
        title: z.string(),
        content: z.string(),
      }),
    ),
    /** package id -> package info */
    packages: z.record(
      z.string(),
      z.object({
        type: z.enum(["major", "minor", "patch"]),
        changelogIds: z.codec(z.array(z.string()), z.set(z.string()), {
          encode: (v) => Array.from(v),
          decode: (v) => new Set(v),
        }),
        distTag: z.string().optional(),
        publish: z.boolean(),
      }),
    ),
  }),
);

export type PlanStore = z.output<typeof planStoreSchema>;
