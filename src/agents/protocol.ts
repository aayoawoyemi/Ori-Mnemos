export type AgentNoteMetadata = {
  agent?: string;
  created_by?: string;
};

export function buildInboxFilename(
  title: string,
  agentName?: string
): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  const prefix = agentName ? `${agentName}-` : "";
  return `${prefix}${base}.md`;
}