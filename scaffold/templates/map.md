---
_schema:
  entity_type: "map"
  applies_to: "notes/*-map.md"
  required:
    - description
    - type
  optional:
    - project
  enums:
    type:
      - moc
  constraints:
    description:
      max_length: 200
      format: "One sentence describing what this map covers"

# Template fields
description: ""
type: moc
---

# {map name}

{Brief description of what this map covers and why it exists.}

## Key Notes
{Links to the most important notes in this area}

## Recent Additions
{Links to recently added notes - keeps the map fresh}

---

Areas:
- [[index]]
