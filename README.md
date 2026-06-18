![Logo](./apps/docs/public/logo.png)

> This project is still in beta, the API is unstable and may contains bugs. Not recommended to use in production or serious projects.

## Tegami

A tool for versioning & publishing packages.

It was mainly created as a better alternative for Changesets, with solutions to some unsolved issues & problems.

- **Cross-registry version management**: support across npm, cargo, and other registries via plugins.
- **Weird update dependencies bump**: changesets will generate a major bump for `workspace:*` in peer dependencies, but it is not configurable. Tegami allows flexible dependencies bump behaviour, and it detects package groups to avoid unnecessary bumps.
- **Programmatic API**: allows robust use cases of the tool, such as using the `willPublish()` hook on plugins to allow packages to only be built when published.
