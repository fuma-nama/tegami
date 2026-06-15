import z from "zod";
import { jsonCodec } from "../schemas";
import { DraftPlan } from "./draft";

const packagePlanStoreSchema = z.object({
  type: z.enum(["major", "minor", "patch"]),
  changelogIds: z.codec(z.array(z.string()), z.set(z.string()), {
    encode: (v) => Array.from(v),
    decode: (v) => new Set(v),
  }),
  npm: z
    .object({
      distTag: z.string().optional(),
    })
    .optional(),
  publish: z.boolean(),
});

/** the persisted plan data for actual publishing */
const planStoreSchema = jsonCodec(
  z.object({
    id: z.string(),
    createdAt: z.iso.datetime(),
    // TODO: use 1.0.0 when stable, before that, backward compatibility won't be considered
    version: z.literal("0.0.0").default("0.0.0"),
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
    packages: z.record(z.string(), packagePlanStoreSchema),
  }),
);

export type PlanStore = z.output<typeof planStoreSchema>;
export type PackagePlanStore = z.output<typeof packagePlanStoreSchema>;

export function createPlanStore(draft: DraftPlan): string {
  const store: z.output<typeof planStoreSchema> = {
    version: "0.0.0",
    id: `tegami-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    changelogs: {},
    packages: {},
  };
  for (const id of draft.getChangelogIds()) {
    const entry = draft.getChangelog(id)!;
    store.changelogs[id] = {
      filename: entry.filename,
      subject: entry.subject,
      packages: Array.from(entry.packages),
      type: entry.type,
      title: entry.title,
      content: entry.content,
    };
  }
  for (const id of draft.getPackageIds()) {
    store.packages[id] = draft.getPackage(id)!;
  }

  return planStoreSchema.encode(store);
}

export function parsePlanStore(content: string): PlanStore {
  return planStoreSchema.decode(content);
}
