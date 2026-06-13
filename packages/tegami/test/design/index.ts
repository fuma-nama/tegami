// my-repo/tegami.ts
import { tegami } from "../../src";
import { githubRelease } from "../../src/plugins/github";

const paper = tegami({
  // create release on GitHub
  plugins: [githubRelease()],
  packages: {
    "my-pkg": {
      distTag: "alpha",
    },
  },
});

export async function version() {
  const draft = await paper.draft();
  console.log(draft.changelogs);

  for (const pkg of draft.packages) {
    console.log("will be published", pkg.name, pkg.version);
    // Changelog entries are stored once on the plan; packages reference them by id.
    console.log(pkg.changelogIds);
  }

  // generate .tegami/publish-plan.json and delete all changelogs
  // it refuses to create a new plan until the current one has finished publishing
  await draft.createPublishPlan();

  // plan will be freezed once created, no further `create()` calls allowed
}

export async function publish() {
  /// publish according to `publish-plan.json`.
  // existing package versions are treated as successful, so reruns are safe after partial failures.
  const result = await paper.publish();

  // read published packages, or add custom followups
  console.log(result);

  // for example, to auto-configure trusted publishing
  if (result.state !== "success") return;

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
  const graph = await paper.graph();

  graph.get("package-name");
}

async function configureTrustedPublishing(packageId: string) {
  console.log("configure trusted publishing", packageId);
}
