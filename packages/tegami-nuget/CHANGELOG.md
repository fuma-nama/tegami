## @tegami/nuget@0.2.0

### Migrate to the Tegami publish task system

The plugin now publishes through Tegami's task graph instead of the deprecated `publish` / `resolvePlanStatus` hooks. Requires `tegami@^1.3.0`.

Git-tag publishers (Composer, Swift, Zig's `git-tag` strategy) now wait for the git plugin's actual tag work: a package reports `published` when this run created its tag, `skipped` when the tag already existed, and fails when tag creation failed.

## @tegami/nuget@0.1.0

### Add NuGet support

Tegami now includes an opt-in `@tegami/nuget` plugin that discovers `.csproj`/`.fsproj` projects, resolves versions through `Directory.Build.props` inheritance, rewrites package references, and publishes with `dotnet nuget push`.
