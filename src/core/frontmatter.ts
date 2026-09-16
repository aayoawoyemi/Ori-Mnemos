// Module invariant: renameWithRetry below holds the only fs.rename call in the
// repository, and every write path goes through it. A direct fs.rename looks
// correct on POSIX and fails intermittently on Windows only under load, which
// is the worst failure signature there is - see the EPERM note on the helper.
// The tests in tests/core/frontmatter.test.ts and tests/cli/promote.test.ts
// enforce this behaviourally: they inject a transient EPERM into fs.rename and
// require every write path to survive it, so a bypass turns them red.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import yaml from "yaml";

export type FrontmatterParseResult = {
  data: Record<string, unknown> | null;
  body: string;
  errors: string[];
};

const FRONTMATTER_BOUNDARY = "---";

export function parseFrontmatter(content: string): FrontmatterParseResult {
  const errors: string[] = [];
  const lines = content.split(/\r?\n/);
  if (lines[0] !== FRONTMATTER_BOUNDARY) {
    return { data: null, body: content, errors };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === FRONTMATTER_BOUNDARY) {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { data: null, body: content, errors: ["Unterminated frontmatter"] };
  }

  const raw = lines.slice(1, endIndex).join("\n");
  let data: Record<string, unknown> | null = null;
  try {
    const parsed = yaml.parse(raw);
    if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    } else {
      data = {};
    }
  } catch (err) {
    errors.push(`Invalid YAML frontmatter: ${(err as Error).message}`);
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { data, body, errors };
}

export function stringifyFrontmatter(
  data: Record<string, unknown>,
  body: string
): string {
  const doc = yaml.stringify(data).trimEnd();
  if (doc.length === 0) {
    return body;
  }
  const normalizedBody = body.startsWith("\n") ? body.slice(1) : body;
  return `${FRONTMATTER_BOUNDARY}\n${doc}\n${FRONTMATTER_BOUNDARY}\n${normalizedBody}`;
}

export async function readFrontmatterFile(
  filePath: string
): Promise<FrontmatterParseResult> {
  const content = await fs.readFile(filePath, "utf8");
  return parseFrontmatter(content);
}

let tempSequence = 0;

function tempSiblingPath(filePath: string): string {
  // Same directory as the target: rename is only atomic within a filesystem,
  // so os.tmpdir() is not a valid staging area. Dot-prefixed and suffixed
  // .tmp so vault scanners (which match *.md) and Obsidian both skip it.
  const unique = `${process.pid.toString(36)}-${(tempSequence += 1).toString(36)}-${randomBytes(4).toString("hex")}`;
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${unique}.tmp`
  );
}

// Cumulative 502 ms. Measured on NTFS with eight writers replacing one file:
// the transient refusal never outlived the fifth step (31 ms), so this ladder
// is roughly sixteen times the observed worst case.
const RENAME_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 125, 250];

const RENAME_RETRY_CODES: Record<string, true> = {
  EPERM: true,
  EACCES: true,
  EBUSY: true,
};

/**
 * Rename onto a path that may already exist, tolerating the transient refusals
 * Windows produces under concurrency.
 *
 * MoveFileEx with REPLACE_EXISTING fails ERROR_ACCESS_DENIED (EPERM) whenever
 * the destination is momentarily open: another process replacing the same note,
 * an antivirus filter, the search indexer. Two concurrent writers to one note
 * make it near-certain - measured 374 EPERM out of 480 renames with eight
 * writers on one file, and it is what made the concurrent-writer test red only
 * under full-suite load. The rename is still atomic; it is the attempt that is
 * refused, so the remedy is to wait and retry, the same thing node does for
 * fs.rm's maxRetries on Windows. POSIX rename has no such failure and takes
 * the first attempt.
 *
 * A caller that trusts this helper must never be handed a spurious failure:
 * atomicity is worthless if it converts a corrupt write into a lost one.
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        attempt >= RENAME_RETRY_DELAYS_MS.length ||
        code === undefined ||
        RENAME_RETRY_CODES[code] !== true
      ) {
        throw err;
      }
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Write a file by staging the content in a sibling temp file and renaming it
 * over the target. A concurrent reader observes either the previous content
 * or the complete new content, never a truncated prefix, and a crash mid-write
 * leaves the target untouched.
 *
 * The staged data is fsynced before the rename, so a crash cannot leave the
 * renamed directory entry pointing at unflushed (zero-filled) blocks. The
 * containing directory is deliberately not fsynced: Windows cannot open a
 * directory for that, and the guarantee needed here is that the visible file
 * is never partial, not that the rename itself survives a power cut.
 *
 * Replacing the target by rename replaces its inode, so an existing file's
 * permission bits are copied onto the staged file first; without that, a note
 * the user had chmod'ed would silently revert to the default mode.
 *
 * On any failure the temp file is removed and the error is rethrown, so the
 * caller sees the same failure it would have seen from a plain write.
 */
export async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const tempPath = tempSiblingPath(filePath);
  const existing = await fs.stat(filePath).catch(() => null);
  try {
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      if (existing) {
        await handle.chmod(existing.mode & 0o777);
      }
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function writeFrontmatterFile(
  filePath: string,
  data: Record<string, unknown>,
  body: string
): Promise<void> {
  const content = stringifyFrontmatter(data, body);
  await writeFileAtomic(filePath, content);
}

export async function writeTempFrontmatter(
  data: Record<string, unknown>,
  body: string
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ori-frontmatter-"));
  const filePath = path.join(dir, "note.md");
  await writeFrontmatterFile(filePath, data, body);
  return filePath;
}