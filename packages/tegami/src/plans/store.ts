import z from "zod";
import { bumpTypeSchema, jsonCodec } from "../schemas";
import type { DraftPlan } from "./draft";
import type { TegamiContext } from "../context";
import { readFile } from "fs/promises";

const packagePlanStoreSchema = z.object({
  type: bumpTypeSchema.optional(),
  changelogIds: z.array(z.string()).optional(),
  bumpReasons: z.array(z.string()).optional(),
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
    changelogs: z.record(z.string(), z.object({ filename: z.string(), content: z.string() })),
    /** package id -> package info */
    packages: z.record(z.string(), packagePlanStoreSchema),
  }),
);

export type PlanStore = z.output<typeof planStoreSchema>;
export type PackagePlanStore = z.output<typeof packagePlanStoreSchema>;

export function createPlanStore(draft: DraftPlan, context: TegamiContext): string {
  const store: z.output<typeof planStoreSchema> = {
    version: "0.0.0",
    id: `tegami-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    changelogs: {},
    packages: {},
  };
  for (const entry of draft.getChangelogs()) {
    store.changelogs[entry.id] = {
      filename: entry.filename,
      content: entry.getRawContent(),
    };
  }
  for (const pkg of context.graph.getPackages()) {
    const plan = draft.getPackagePlan(pkg.id);
    if (plan) {
      store.packages[pkg.id] = {
        publish: plan.publish ?? false,
        type: plan.type,
        npm: plan.npm,
        changelogIds: plan.changelogs?.map((entry) => entry.id),
        bumpReasons: plan.bumpReasons ? Array.from(plan.bumpReasons) : undefined,
      };
    }
  }

  return planStoreSchema.encode(store);
}

export function parsePlanStore(content: string): PlanStore {
  return planStoreSchema.decode(content);
}

export async function readPlanStore(context: TegamiContext) {
  try {
    return planStoreSchema.decode(await readFile(context.planPath, "utf8"));
  } catch {}
}
