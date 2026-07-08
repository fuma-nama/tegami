---
packages:
  "npm:@tegami/zig": patch
---

### Add Zig package support

Tegami now includes an opt-in `@tegami/zig` plugin that discovers `build.zig.zon` packages, follows local `.path` dependencies, bumps dependent packages, and preserves manifest comments while updating package versions.
