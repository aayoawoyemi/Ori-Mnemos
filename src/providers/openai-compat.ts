import type {
  LlmProvider,
  VaultContext,
  EnhancementSuggestions,
} from "../core/llm.js";

const SYSTEM_PROMPT = `You are a knowledge management assistant for Ori Mnemos, a markdown-native memory system.
Your job is to enhance a note that is being promoted from inbox to permanent storage.

Given a note's title, body, and frontmatter, plus context about the vault's existing notes:
1. Suggest a better description (one sentence, max 200 chars, no trailing period)
2. Classify the type: idea, decision, learning, insight, blocker, or opportunity
3. Suggest wiki-links to existing notes that are relevant
4. Suggest project tags if applicable
5. Explain your reasoning briefly

Respond with valid JSON matching this schema:
{
  "type": "string (one of: idea, decision, learning, insight, blocker, opportunity)",
  "description": "string (one sentence, max 200 chars)",
  "links": ["string array of existing note titles to link to"],
  "project": ["string array of project tags"],
  "reasoning": "string (brief explanation)"
}

Only include fields where you have a confident suggestion. Omit fields you're unsure about.`;

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAICompatProvider implements LlmProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model: string, baseUrl?: string | null) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async enhance(
    note: {
      title: string;
      body: string;
      frontmatter: Record<string, unknown>;
    },
    context: VaultContext
  ): Promise<EnhancementSuggestions> {
    const userMessage = [
      `## Note to enhance`,
      `Title: ${note.title}`,
      `Body: ${note.body.slice(0, 2000)}`,
      `Current frontmatter: ${JSON.stringify(note.frontmatter)}`,
      ``,
      `## Vault context`,
      `Existing notes: ${context.existingTitles.slice(0, 50).join(", ")}`,
      `Recent notes: ${context.recentNotes
        .slice(0, 10)
        .map((n) => `${n.title} (${n.type})`)
        .join(", ")}`,
      `Known projects: ${context.projectTags.join(", ")}`,
    ].join("\n");

    try {
      const response = await fetch(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1024,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: userMessage },
            ],
          }),
        }
      );

      if (!response.ok) {
        return {};
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content;
      if (!text) return {};

      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};

      const parsed = JSON.parse(jsonMatch[0]) as EnhancementSuggestions;

      // Validate and sanitize
      const result: EnhancementSuggestions = {};
      if (typeof parsed.type === "string") result.type = parsed.type;
      if (typeof parsed.description === "string")
        result.description = parsed.description.slice(0, 200);
      if (Array.isArray(parsed.links)) result.links = parsed.links;
      if (Array.isArray(parsed.project)) result.project = parsed.project;
      if (typeof parsed.reasoning === "string")
        result.reasoning = parsed.reasoning;

      return result;
    } catch {
      // LLM failures should never block promotion
      return {};
    }
  }
}
