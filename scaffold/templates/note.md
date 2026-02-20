---
_schema:
  entity_type: "note"
  applies_to: "notes/*.md"
  required:
    - description
    - type
    - project
    - status
    - created
  optional:
    - confidence
    - alternatives
    - rationale
    - superseded_by
    - next_step
    - source
  enums:
    type:
      - idea
      - decision
      - learning
      - insight
      - blocker
      - opportunity
    status:
      - inbox
      - active
      - completed
      - superseded
      - archived
    confidence:
      - speculative
      - promising
      - validated
  constraints:
    description:
      max_length: 200
      format: "One sentence adding context beyond the title"
    project:
      format: "Array of project tags"

# Template fields
description: ""
type: ""
project: []
status: active
created: YYYY-MM-DD
---

# {prose-as-title: a complete thought that works as a statement}

{Content - your reasoning, evidence, context. Transform the material, don't just summarize.}

---

Relevant Notes:
- [[related note]] -- why this connection matters

Areas:
- [[relevant map]]
