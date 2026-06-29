---
packages:
  "npm:tegami": patch
---

### Fix CLI parsing for options without short flags

Release preview workflows failed when passing `--artifact` because Node's argument parser rejects `short: undefined`.
