/**
 * Mechanical temporal grammar (design v2): dates from ISO strings only, never words.
 */
export type Temporal = { capturedAt: string | null; eventDate: string | null };

export function parseTemporal(line: string, fallbackCapturedAt: string | null): Temporal {
  const markerRegex = /^[-*]\s*\[.\]\s*(\d{4}-\d{2}-\d{2}):/;
  let capturedAt: string | null = null;
  const markerMatch = line.match(markerRegex);
  if (markerMatch) {
    capturedAt = markerMatch[1];
  } else {
    capturedAt = fallbackCapturedAt;
  }

  const wordDateRegex = /\b(?:on|at|for|due)\s+(\d{4}-\d{2}-\d{2})\b/i;
  const wordDateMatch = line.match(wordDateRegex);
  if (wordDateMatch) {
    return { capturedAt, eventDate: wordDateMatch[1] };
  }

  const isoDateRegex = /(\d{4}-\d{2}-\d{2})/g;
  const dates: string[] = [];
  let m;
  while ((m = isoDateRegex.exec(line)) !== null) {
    dates.push(m[1]);
  }
  let eventDate: string | null = null;
  if (dates.length > 1) {
    // find a date that differs from capturedAt
    for (const d of dates) {
      if (d !== capturedAt) {
        eventDate = d;
        break;
      }
    }
    if (!eventDate) {
      eventDate = dates[1];
    }
  } else if (dates.length === 1 && !capturedAt) {
    eventDate = dates[0];
  }
  return { capturedAt, eventDate };
}

export function classifyReminder(t: Temporal, today: string): "upcoming" | "due" | "expired" | "note" {
  const ed = t.eventDate;
  if (!ed) return "note";
  if (ed > today) return "upcoming";
  if (ed === today) return "due";
  return "expired";
}
