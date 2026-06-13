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
    })
    .optional(),
  workspaces: workspacePatternsSchema.optional(),
  dependencies: stringRecordSchema.optional(),
  devDependencies: stringRecordSchema.optional(),
  peerDependencies: stringRecordSchema.optional(),
  optionalDependencies: stringRecordSchema.optional(),
});

export type PackageManifest = z.infer<typeof packageManifestSchema>;

/** Parsed release note entry from a changelog markdown file. */
export const changelogEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  subject: z.string().optional(),
  packages: z.array(z.string()),
  type: z.enum(["major", "minor", "patch"]),
  title: z.string(),
  content: z.string(),
});

export const packagePlanSchema = z.object({
  name: z.string(),
  version: z.string(),
  changelogIds: z.codec(z.array(z.string()), z.set(z.string()), {
    encode: (v) => Array.from(v),
    decode: (v) => new Set(v),
  }),
  distTag: z.string(),
  gitTag: z.union([z.string(), z.literal(false)]),
  publish: z.boolean(),
});

export const publishPlanSchema = jsonCodec(
  z
    .object({
      id: z.string(),
      createdAt: z.iso.datetime(),
      changelogs: z.array(changelogEntrySchema),
      packages: z.array(packagePlanSchema),
    })
    .superRefine((plan, context) => {
      const seen = new Set<string>();

      for (const [index, pkg] of plan.packages.entries()) {
        if (!seen.has(pkg.name)) {
          seen.add(pkg.name);
          continue;
        }

        context.addIssue({
          code: "custom",
          message: `Duplicate package in publish plan: ${pkg.name}`,
          path: ["packages", index, "name"],
        });
      }
    }),
);

export type PublishPlan = z.output<typeof publishPlanSchema>;
export type PackagePlan = z.output<typeof packagePlanSchema>;
export type ChangelogEntry = z.output<typeof changelogEntrySchema>;
