import {
  classifyNoteType,
  detectProjects,
  type ClassificationResult,
  type ProjectKeywordConfig,
} from "./classify.js";
import {
  detectLinks,
  applyLinks,
  suggestLinks,
  type DetectedLink,
  type LinkSuggestion,
  type VaultIndex,
} from "./linkdetect.js";

export type PromoteOverrides = {
  type?: string;
  description?: string;
  links?: string[];
  project?: string[];
};

export type PromoteInput = {
  inboxPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  existingTitles: string[];
  vaultIndex: VaultIndex;
  overrides: PromoteOverrides;
  projectConfig: ProjectKeywordConfig;
  mapRouting: Record<string, string>;
  defaultArea: string;
};

export type PromoteResult = {
  updatedFrontmatter: Record<string, unknown>;
  updatedBody: string;
  destinationFilename: string;
  classification: ClassificationResult;
  detectedLinks: DetectedLink[];
  suggestedLinks: LinkSuggestion[];
  suggestedAreas: string[];
  changes: string[];
  warnings: string[];
};

const AUTO_APPLY_THRESHOLD = 0.8;

const TEMPLATE_PLACEHOLDER = /\{Content\s*[-—]/;

/**
 * Check if a note body still contains the unfilled template placeholder.
 * Used as a quality gate to prevent promoting empty stubs.
 */
export function isTemplatePlaceholder(body: string): boolean {
  return TEMPLATE_PLACEHOLDER.test(body);
}

/**
 * Parse an existing footer section from the body.
 * Looks for "## <heading>" or "<heading>:" followed by lines starting with "- ".
 */
function parseFooter(body: string, heading: string): string[] {
  // Match both "## Areas" and "Areas:" formats
  const patterns = [
    new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, "m"),
    new RegExp(`^${escapeRegex(heading)}:\\s*$`, "m"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(body);
    if (!match) continue;

    const startIdx = match.index + match[0].length;
    const items: string[] = [];
    const remaining = body.slice(startIdx);
    const lines = remaining.split("\n");

    const knownHeadings = ["Relevant Notes", "Areas"];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ")) {
        // Extract wiki-link title from "- [[title]]" or "- [[title]] -- reason"
        const linkMatch = trimmed.match(/^-\s+\[\[([^\]]+)\]\]/);
        if (linkMatch) {
          items.push(linkMatch[1]);
        }
      } else if (trimmed.length === 0) {
        continue;
      } else if (
        trimmed.startsWith("#") ||
        trimmed.startsWith("---") ||
        knownHeadings.some((h) => trimmed === `${h}:` || trimmed === `## ${h}`)
      ) {
        break;
      }
    }
    return items;
  }
  return [];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip existing footer sections (Areas and Relevant Notes) from body.
 * Line-based approach for reliability.
 */
function stripFooters(body: string): string {
  const headings = ["Relevant Notes", "Areas"];
  const lines = body.split("\n");
  const kept: string[] = [];
  let inFooterSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check if this line starts a footer section
    const isHeading = headings.some(
      (h) =>
        trimmed === `${h}:` ||
        trimmed === `## ${h}` ||
        trimmed.startsWith(`${h}:`)
    );

    if (isHeading) {
      inFooterSection = true;
      continue;
    }

    if (inFooterSection) {
      // Stay in footer section for list items and blank lines
      if (trimmed.startsWith("- ") || trimmed === "") {
        continue;
      }
      // Non-list, non-blank line exits the footer section
      inFooterSection = false;
    }

    kept.push(line);
  }

  return kept.join("\n").trimEnd();
}

/**
 * Format footer sections.
 */
function formatFooters(areas: string[], links: string[]): string {
  let footer = "";

  if (links.length > 0) {
    footer += "\n\nRelevant Notes:";
    for (const link of links) {
      footer += `\n- [[${link}]]`;
    }
  }

  if (areas.length > 0) {
    footer += "\n\nAreas:";
    for (const area of areas) {
      footer += `\n- [[${area}]]`;
    }
  }

  return footer + "\n";
}

/**
 * Inject footers with idempotency: parse existing, merge, dedupe, write once.
 */
export function injectFooters(
  body: string,
  areas: string[],
  links: string[]
): string {
  const existingAreas = parseFooter(body, "Areas");
  const existingLinks = parseFooter(body, "Relevant Notes");

  const mergedAreas = [...new Set([...existingAreas, ...areas])];
  const mergedLinks = [...new Set([...existingLinks, ...links])];

  const cleanBody = stripFooters(body);

  if (mergedAreas.length === 0 && mergedLinks.length === 0) {
    return cleanBody + "\n";
  }

  return cleanBody + formatFooters(mergedAreas, mergedLinks);
}

/**
 * Resolve areas for a note based on project tags and map routing config.
 * Fallback chain: config routing → keyword match on map titles → defaultArea.
 */
function resolveAreas(
  projects: string[],
  mapRouting: Record<string, string>,
  existingTitles: string[],
  defaultArea: string
): string[] {
  const areas: string[] = [];

  for (const project of projects) {
    // Direct config routing
    if (mapRouting[project]) {
      areas.push(mapRouting[project]);
      continue;
    }
    // Keyword match against existing map titles (titles containing "map")
    const mapTitle = existingTitles.find(
      (t) =>
        t.toLowerCase().includes(project.toLowerCase()) &&
        t.toLowerCase().includes("map")
    );
    if (mapTitle) {
      areas.push(mapTitle);
    }
  }

  // Ensure at least one area — zero orphans from promotion
  if (areas.length === 0) {
    areas.push(defaultArea);
  }

  return [...new Set(areas)];
}

/**
 * Compute the promotion result without performing any I/O.
 * The caller (CLI or MCP) handles file move, validation, etc.
 */
export function computePromotion(input: PromoteInput): PromoteResult {
  const {
    inboxPath,
    frontmatter,
    body,
    existingTitles,
    vaultIndex,
    overrides,
    projectConfig,
    mapRouting,
    defaultArea,
  } = input;

  const changes: string[] = [];
  const warnings: string[] = [];

  // 1. Classify type
  const classification = classifyNoteType(
    titleFromPath(inboxPath),
    body,
    (overrides.type as string) ?? (frontmatter.type as string | undefined)
  );
  if (classification.confidence === "low" && !overrides.type) {
    warnings.push(
      `Low-confidence type classification: ${classification.type} (${classification.reason}). Use --type to override.`
    );
  }
  if (overrides.type && overrides.type !== frontmatter.type) {
    changes.push(`type: ${frontmatter.type ?? "unset"} → ${overrides.type}`);
  } else if (classification.type !== frontmatter.type) {
    changes.push(
      `type classified as ${classification.type} (${classification.confidence} confidence)`
    );
  }

  // 2. Detect projects
  let projects: string[];
  if (overrides.project && overrides.project.length > 0) {
    projects = overrides.project;
    changes.push(`project set to: ${projects.join(", ")}`);
  } else if (
    Array.isArray(frontmatter.project) &&
    frontmatter.project.length > 0
  ) {
    projects = frontmatter.project as string[];
  } else {
    projects = detectProjects(
      titleFromPath(inboxPath),
      body,
      projectConfig
    );
    if (projects.length > 0) {
      changes.push(`project detected: ${projects.join(", ")}`);
    } else {
      warnings.push("No project detected. Consider adding --project.");
    }
  }

  // 3. Detect wiki-links in body text
  const detectedLinks = detectLinks(body, existingTitles);
  const unlinked = detectedLinks.filter((l) => !l.alreadyLinked);
  if (unlinked.length > 0) {
    changes.push(`auto-linked ${unlinked.length} mention(s) in body`);
  }

  // 4. Suggest structural links
  const allSuggested = suggestLinks(
    { ...frontmatter, project: projects },
    body,
    vaultIndex
  );
  // Auto-apply high-confidence suggestions
  const autoApplied = allSuggested.filter(
    (s) => s.confidence >= AUTO_APPLY_THRESHOLD
  );
  const manualSuggestions = allSuggested.filter(
    (s) => s.confidence < AUTO_APPLY_THRESHOLD
  );

  if (manualSuggestions.length > 0) {
    changes.push(
      `suggested ${manualSuggestions.length} connection(s): ${manualSuggestions.map((s) => s.title).join(", ")}`
    );
  }

  // 5. Apply links to body
  let updatedBody = applyLinks(body, detectedLinks);

  // Add override links if provided
  if (overrides.links && overrides.links.length > 0) {
    changes.push(
      `added ${overrides.links.length} explicit link(s): ${overrides.links.join(", ")}`
    );
  }

  // 6. Resolve areas
  const suggestedAreas = resolveAreas(
    projects,
    mapRouting,
    existingTitles,
    defaultArea
  );
  changes.push(`assigned to area(s): ${suggestedAreas.join(", ")}`);

  // 7. Inject footers (idempotent)
  const allLinks = [
    ...autoApplied.map((s) => s.title),
    ...(overrides.links ?? []),
  ];
  updatedBody = injectFooters(updatedBody, suggestedAreas, allLinks);

  // 8. Update frontmatter
  const updatedFrontmatter: Record<string, unknown> = {
    ...frontmatter,
    status: "active",
    type: classification.type,
    project: projects.length > 0 ? projects : frontmatter.project,
    last_accessed: new Date().toISOString().split("T")[0],
    access_count:
      (typeof frontmatter.access_count === "number"
        ? frontmatter.access_count
        : 0) + 1,
  };

  if (overrides.description) {
    updatedFrontmatter.description = overrides.description;
    changes.push("description updated via override");
  } else if (
    !frontmatter.description ||
    (typeof frontmatter.description === "string" &&
      frontmatter.description.trim().length === 0)
  ) {
    warnings.push(
      'No description found. Add with --description "..." or configure LLM.'
    );
  }

  changes.push("status: inbox → active");

  // 9. Derive destination filename
  const filename = inboxPath.split(/[/\\]/).pop() ?? "note.md";
  const destinationFilename = filename.endsWith(".md")
    ? filename
    : `${filename}.md`;

  return {
    updatedFrontmatter,
    updatedBody,
    destinationFilename,
    classification,
    detectedLinks,
    suggestedLinks: allSuggested,
    suggestedAreas,
    changes,
    warnings,
  };
}

function titleFromPath(filePath: string): string {
  const filename = filePath.split(/[/\\]/).pop() ?? "";
  return filename.replace(/\.md$/, "").replace(/-/g, " ");
}
