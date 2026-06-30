---
packages:
  npm:tegami:
    replay:
      - "exit prerelease: npm:tegami"
---

### Add pip plugin

Tegami now includes an opt-in pip plugin at `@tegami/pip` for Python monorepos. It discovers packages from `pyproject.toml`, supports uv workspaces, bumps dependency ranges, runs `uv lock` after versioning, and publishes to PyPI with `uv publish`.
