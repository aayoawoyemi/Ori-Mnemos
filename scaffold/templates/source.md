---
_schema:
  entity_type: "source"
  applies_to: "inbox/*.md"
  required:
    - description
    - source_type
    - status
    - created
  optional:
    - url
    - author
    - research_tool
    - research_query
  enums:
    source_type:
      - article
      - voice-note
      - conversation
      - documentation
      - video
      - tweet
      - raw-idea
    status:
      - unprocessed
      - processing
      - processed
      - skipped

# Template fields
description: ""
source_type: ""
status: unprocessed
created: YYYY-MM-DD
---

# {source title or description}

{Raw content, transcript, or notes from the source}

---

Processing Notes:
- Extracted: {count} notes
- Key insights: {brief list}
