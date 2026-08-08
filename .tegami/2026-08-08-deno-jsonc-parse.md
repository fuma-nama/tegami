---
packages:
  npm:tegami: patch
---

### Fix `deno.jsonc` parsing

Resolving a Deno workspace no longer fails with `failed to parse "…/deno.jsonc"`. The published bundle inlined `jsonc-parser`'s UMD build, whose internal `require("./impl/…")` calls were left as runtime requires that could not be resolved from `dist/`. The bundler now prefers the package's ESM build.
