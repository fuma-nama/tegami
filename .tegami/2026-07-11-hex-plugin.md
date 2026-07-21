---
packages:
  npm:@tegami/hex:
    type: minor
---

### Add Elixir Mix support

Tegami now includes an opt-in `@tegami/hex` plugin that discovers Mix projects and umbrella apps, rewrites Elixir version requirements, and publishes with `mix hex.publish`.
