## @tegami/gradle@0.1.0

### Add Gradle support

Tegami now includes an opt-in `@tegami/gradle` plugin that discovers Gradle projects from `settings.gradle(.kts)`, resolves coordinates from build scripts and `gradle.properties`, bumps dependents through `project(":core")` dependencies, and publishes with `./gradlew publish`.

Both plain Gradle keys (`version`, `group`) and the `gradle-maven-publish-plugin` conventions (`VERSION_NAME`, `GROUP`, `POM_ARTIFACT_ID`) are read by default, and a version shared through the root `gradle.properties` or an `allprojects {}` block is bumped in one place so those projects release together.
