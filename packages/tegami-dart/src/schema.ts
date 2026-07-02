import z from "zod";

const dartDependencySchema: z.ZodType<DartDependency> = z.union([
  z.string(),
  z.looseObject({
    version: z.string().optional(),
    hosted: z
      .union([z.string(), z.looseObject({ name: z.string().optional(), url: z.string() })])
      .optional(),
    path: z.string().optional(),
    git: z.unknown().optional(),
    sdk: z.string().optional(),
  }),
]);

export const pubspecSchema = z.looseObject({
  name: z.string().optional(),
  version: z.string().optional(),
  publish_to: z.string().optional(),
  resolution: z.string().optional(),
  workspace: z.array(z.string()).optional(),
  dependencies: z.record(z.string(), dartDependencySchema).optional(),
  dev_dependencies: z.record(z.string(), dartDependencySchema).optional(),
  dependency_overrides: z.record(z.string(), dartDependencySchema).optional(),
});

export type DartDependency =
  | string
  | {
      version?: string;
      hosted?: string | { name?: string; url: string };
      path?: string;
      git?: unknown;
      sdk?: string;
      [key: string]: unknown;
    };

export type Pubspec = z.infer<typeof pubspecSchema>;

export const hostedPackageSchema = z.object({
  versions: z
    .array(
      z.object({
        version: z.string(),
      }),
    )
    .optional(),
});
