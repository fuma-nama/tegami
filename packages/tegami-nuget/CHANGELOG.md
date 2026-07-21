## @tegami/nuget@0.1.0

### Add NuGet support

Tegami now includes an opt-in `@tegami/nuget` plugin that discovers `.csproj`/`.fsproj` projects, resolves versions through `Directory.Build.props` inheritance, rewrites package references, and publishes with `dotnet nuget push`.
