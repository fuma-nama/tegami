---
packages:
  npm:tegami: patch
---

### Fix git tag task on re-runs

The git plugin now resolves the local and origin state of the release tags up-front, and only creates & pushes the tags that are actually missing.

Re-running a publish for versions that were already released no longer fails: tags that exist on origin are left untouched instead of being recreated at the current commit and rejected by the push.
