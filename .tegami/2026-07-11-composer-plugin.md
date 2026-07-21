---
packages:
  npm:@tegami/composer:
    type: minor
---

### Add Composer support

Tegami now includes an opt-in `@tegami/composer` plugin that discovers PHP packages from `composer.json` path repositories, rewrites workspace constraints, and publishes through git tags for Packagist.
