## @tegami/gem@0.1.0

### Add Ruby gem support

Tegami now includes an opt-in `@tegami/gem` plugin that discovers `*.gemspec` packages, resolves versions from the gemspec or `lib/**/version.rb`, rewrites pessimistic (`~>`) dependency requirements, and publishes with `gem push`.
