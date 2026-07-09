## @tegami/zig@1.2.5

### No longer align with core versions

The package versions of plugins will no longer align with core `tegami` package.

### Add Zig package support

Tegami now includes an opt-in `@tegami/zig` plugin that discovers `build.zig.zon` packages, follows local `.path` dependencies, bumps dependent packages, and preserves manifest comments while updating package versions.
