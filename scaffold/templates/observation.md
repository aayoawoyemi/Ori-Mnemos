---
_schema:
  entity_type: "observation"
  applies_to: "ops/observations/*.md"
  required:
    - description
    - category
    - observed
    - status
  optional: []
  enums:
    category:
      - friction
      - surprise
      - process-gap
      - methodology
      - quality
    status:
      - pending
      - promoted
      - implemented
      - archived

# Template fields
description: ""
category: ""
observed: YYYY-MM-DD
status: pending
---

# {prose-sentence describing what was observed}

{Context - what happened, what was expected, what actually occurred}

---

Topics:
- [[methodology]]
