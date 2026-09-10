// Structure-aware parsing of OpenSpec documents.
//
// `openspec show --json` returns requirements and scenarios but drops
// requirement *names* and all surrounding prose, so the reader parses the
// markdown itself. This is deliberately a shallow, line-oriented pass: it
// recognises the shapes OpenSpec defines and leaves everything else as prose
// for the markdown renderer, so an unrecognised document still reads fine.

export type DeltaOp = "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED";

export interface Scenario {
  name: string;
  markdown: string;
  anchor: string;
}

export interface RequirementBlock {
  type: "requirement";
  name: string;
  /** Delta operation from the enclosing `## <OP> Requirements` heading. */
  op: DeltaOp | null;
  /** Prose between the requirement heading and its first scenario. */
  markdown: string;
  scenarios: Scenario[];
  anchor: string;
}

export interface ProseBlock {
  type: "prose";
  markdown: string;
}

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
  /** Set when the heading declares a delta operation. */
  op: DeltaOp | null;
  anchor: string;
}

export type SpecBlock = RequirementBlock | ProseBlock | HeadingBlock;

export interface TaskItem {
  done: boolean;
  text: string;
}

export interface TaskGroup {
  title: string | null;
  items: TaskItem[];
}

export interface TaskDoc {
  groups: TaskGroup[];
  done: number;
  total: number;
  /** Content that is not a heading or a checkbox, kept so nothing is lost. */
  notes: string;
}

const DELTA_OPS: DeltaOp[] = ["ADDED", "MODIFIED", "REMOVED", "RENAMED"];

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `## ADDED Requirements` -> `ADDED`. */
function deltaOpFrom(headingText: string): DeltaOp | null {
  const upper = headingText.toUpperCase();
  return DELTA_OPS.find((op) => upper.startsWith(op)) ?? null;
}

interface Heading {
  level: number;
  text: string;
}

function asHeading(line: string): Heading | null {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

/** Strip a `Requirement:` / `Scenario:` label off a heading. */
function afterLabel(text: string, label: string): string | null {
  const re = new RegExp(`^${label}\\s*:\\s*(.*)$`, "i");
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

function trimBlank(lines: string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

/**
 * Parse a spec or delta-spec document into blocks.
 *
 * Requirements and scenarios become first-class blocks; anything else is
 * preserved as prose in document order.
 */
export function parseSpec(markdown: string): SpecBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: SpecBlock[] = [];
  let prose: string[] = [];
  let currentOp: DeltaOp | null = null;
  let inFence = false;

  const flushProse = () => {
    const text = trimBlank(prose);
    prose = [];
    if (text) blocks.push({ type: "prose", markdown: text });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Never interpret headings inside a fenced code block.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      prose.push(line);
      continue;
    }
    if (inFence) {
      prose.push(line);
      continue;
    }

    const heading = asHeading(line);
    if (!heading) {
      prose.push(line);
      continue;
    }

    const requirementName =
      heading.level === 3 ? afterLabel(heading.text, "Requirement") : null;

    if (requirementName === null) {
      flushProse();
      const op = heading.level === 2 ? deltaOpFrom(heading.text) : null;
      if (op) currentOp = op;
      blocks.push({
        type: "heading",
        level: heading.level,
        text: heading.text,
        op,
        anchor: slugify(heading.text),
      });
      continue;
    }

    // A requirement owns every line until the next heading of level <= 3.
    flushProse();
    const body: string[] = [];
    const scenarios: Scenario[] = [];
    let scenarioName: string | null = null;
    let scenarioBody: string[] = [];

    const closeScenario = () => {
      if (scenarioName !== null) {
        scenarios.push({
          name: scenarioName,
          markdown: trimBlank(scenarioBody),
          anchor: slugify(`${requirementName}-${scenarioName}`),
        });
      }
      scenarioName = null;
      scenarioBody = [];
    };

    let j = i + 1;
    let bodyFence = false;
    for (; j < lines.length; j++) {
      const inner = lines[j];
      if (/^\s*(```|~~~)/.test(inner)) bodyFence = !bodyFence;
      const innerHeading = bodyFence ? null : asHeading(inner);

      if (innerHeading && innerHeading.level <= 3) break;

      const nextScenario =
        innerHeading && innerHeading.level === 4
          ? afterLabel(innerHeading.text, "Scenario")
          : null;

      if (nextScenario !== null) {
        closeScenario();
        scenarioName = nextScenario;
        continue;
      }
      if (scenarioName !== null) scenarioBody.push(inner);
      else body.push(inner);
    }
    closeScenario();

    blocks.push({
      type: "requirement",
      name: requirementName,
      op: currentOp,
      markdown: trimBlank(body),
      scenarios,
      anchor: slugify(requirementName),
    });
    i = j - 1;
  }

  flushProse();
  return blocks;
}

/** Parse `tasks.md` into groups of checkboxes with progress. */
export function parseTasks(markdown: string): TaskDoc {
  const lines = markdown.split(/\r?\n/);
  const groups: TaskGroup[] = [];
  const notes: string[] = [];
  let current: TaskGroup | null = null;
  let done = 0;
  let total = 0;
  let inFence = false;

  const ensureGroup = () => {
    if (!current) {
      current = { title: null, items: [] };
      groups.push(current);
    }
    return current;
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      notes.push(line);
      continue;
    }
    if (inFence) {
      notes.push(line);
      continue;
    }

    const heading = asHeading(line);
    if (heading) {
      current = { title: heading.text, items: [] };
      groups.push(current);
      continue;
    }

    const task = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (task) {
      const isDone = task[1] !== " ";
      total++;
      if (isDone) done++;
      ensureGroup().items.push({ done: isDone, text: task[2].trim() });
      continue;
    }

    if (line.trim()) notes.push(line);
  }

  return {
    // Drop heading-only groups with no tasks beneath them only if they are
    // empty *and* the document has tasks elsewhere; otherwise keep everything.
    groups: groups.filter((g) => g.items.length > 0 || total === 0),
    done,
    total,
    notes: trimBlank(notes),
  };
}

/** Headings for the in-document outline. */
export function outline(markdown: string): HeadingBlock[] {
  return parseSpec(markdown).flatMap((b) => {
    if (b.type === "heading" && b.level <= 3) return [b];
    if (b.type === "requirement") {
      return [
        {
          type: "heading" as const,
          level: 3,
          text: b.name,
          op: b.op,
          anchor: b.anchor,
        },
      ];
    }
    return [];
  });
}
