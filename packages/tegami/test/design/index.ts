// my-repo/tegami.ts
import { tegami } from "../../src";
import { github } from "../../src/plugins/github";

const paper = tegami({
  // create release on GitHub
  plugins: [github()],
  packages: {
    "fumadocs-core": {
      group: "fumadocs",
    },
    "fumadocs-ui": {
      group: "fumadocs",
    },
  },
  groups: {
    fumadocs: {
      syncGitTag: true,
      syncVersion: true,
    },
  },
});

export async function version() {
  const draft = await paper.draft();

  for (const [id, plan] of draft.getPackagePlans()) {
    console.log("will be planned", id, plan.type);
  }

  // update versions, generate .tegami/publish-plan, and delete all changelogs
  // it refuses to apply a new plan until the current one has finished publishing
  await draft.applyPlan();

  // plan will be frozen once applied, no further apply calls allowed
}

export async function versionWithAutoDispose() {
  await using draft = await paper.draft();

  for (const [id, plan] of draft.getPackagePlans()) {
    console.log("will be planned", id, plan.type);
  }
}

export async function publish() {
  /// publish according to `.tegami/publish-plan`.
  // existing package versions are treated as successful, so reruns are safe after partial failures.
  const result = await paper.publish();

  // read published packages, or add custom followups
  console.log(result);

  // for example, to auto-configure trusted publishing
  if (result.state !== "created") return;

  for (const pkg of result.packages) {
    // success | failed
    if (pkg.state !== "success") continue;

    // custom script etc
    await configureTrustedPublishing(`${pkg.name}@${pkg.version}`);
  }
}

export async function withGraph() {
  // internal dependency graph of Tegami, used for handling dependencies
  // useful for advanced customization or for plugin authors
  const graph = await paper._internal.graph();

  graph.get("npm:package-name");
}

async function configureTrustedPublishing(packageId: string) {
  console.log("configure trusted publishing", packageId);
}
