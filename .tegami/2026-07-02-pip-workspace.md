---
packages:
  "npm:tegami-pip": patch
---

### Align pip workspace handling with uv

Workspace roots are now graph members, root `tool.uv.sources` inherit to members, virtual roots and `exclude` globs are supported, and dependency source lookup uses PEP 503 name normalization.
