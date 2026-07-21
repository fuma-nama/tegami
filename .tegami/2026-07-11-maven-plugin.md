---
packages:
  npm:@tegami/maven:
    type: minor
---

### Add Maven support

Tegami now includes an opt-in `@tegami/maven` plugin that discovers `pom.xml` modules with parent and `${revision}` inheritance, rewrites inter-module versions, and publishes with a configurable `mvn deploy`.
