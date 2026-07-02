import type { TegamiContext } from "../context";
import type { DraftPolicy } from "./draft";

export function groupPolicy(_ctx: TegamiContext): DraftPolicy {
  return {
    id: "group",
    onUpdate({ pkg, packageDraft }) {
      if (!packageDraft.type) return;

      const group = pkg.group;
      if (!group || !group.options.syncBump) return;

      for (const member of group.packages) {
        if (member === pkg) continue;

        this.bumpPackage(member, {
          type: packageDraft.type,
          reason: `sync "${group.name}" group package versions`,
        });
      }
    },
  };
}
