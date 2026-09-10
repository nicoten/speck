import { describe, expect, it } from "vitest";
import { outline, parseSpec, parseTasks, slugify } from "./parse";
import type { RequirementBlock } from "./parse";

const requirements = (md: string) =>
  parseSpec(md).filter((b): b is RequirementBlock => b.type === "requirement");

describe("parseSpec", () => {
  it("keeps the requirement name that the CLI's JSON drops", () => {
    const md = [
      "## ADDED Requirements",
      "### Requirement: Email login",
      "Users SHALL log in with email and password.",
      "",
      "#### Scenario: Valid credentials",
      "- **WHEN** a user submits valid credentials",
      "- **THEN** a session token is returned",
    ].join("\n");

    const [req] = requirements(md);
    expect(req.name).toBe("Email login");
    expect(req.op).toBe("ADDED");
    expect(req.markdown).toBe("Users SHALL log in with email and password.");
    expect(req.scenarios).toHaveLength(1);
    expect(req.scenarios[0].name).toBe("Valid credentials");
    expect(req.scenarios[0].markdown).toContain("**WHEN**");
    expect(req.scenarios[0].markdown).toContain("**THEN**");
  });

  it("carries the delta operation from the enclosing section to each requirement", () => {
    const md = [
      "## ADDED Requirements",
      "### Requirement: One",
      "a",
      "## REMOVED Requirements",
      "### Requirement: Two",
      "**Reason**: obsolete",
      "**Migration**: none",
    ].join("\n");

    const reqs = requirements(md);
    expect(reqs.map((r) => [r.name, r.op])).toEqual([
      ["One", "ADDED"],
      ["Two", "REMOVED"],
    ]);
    expect(reqs[1].markdown).toContain("**Reason**");
  });

  it("leaves op null for a plain spec with no delta headings", () => {
    const md = [
      "# billing Specification",
      "## Purpose",
      "Handle invoices.",
      "## Requirements",
      "### Requirement: Invoice generation",
      "The system SHALL generate invoices monthly.",
    ].join("\n");

    const [req] = requirements(md);
    expect(req.op).toBeNull();
    expect(req.name).toBe("Invoice generation");
  });

  it("attaches multiple scenarios to one requirement", () => {
    const md = [
      "### Requirement: Login",
      "prose",
      "#### Scenario: Happy path",
      "- **THEN** ok",
      "#### Scenario: Wrong password",
      "- **THEN** rejected",
    ].join("\n");

    const [req] = requirements(md);
    expect(req.scenarios.map((s) => s.name)).toEqual([
      "Happy path",
      "Wrong password",
    ]);
    expect(req.markdown).toBe("prose");
  });

  it("ends a requirement at the next requirement or section heading", () => {
    const md = [
      "### Requirement: First",
      "one",
      "### Requirement: Second",
      "two",
      "## Notes",
      "trailing prose",
    ].join("\n");

    const reqs = requirements(md);
    expect(reqs.map((r) => r.markdown)).toEqual(["one", "two"]);
    const blocks = parseSpec(md);
    expect(blocks.at(-1)).toEqual({ type: "prose", markdown: "trailing prose" });
  });

  it("preserves prose and headings that are not requirements", () => {
    const md = ["# Title", "Intro paragraph.", "## Purpose", "Why."].join("\n");
    const blocks = parseSpec(md);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "prose",
      "heading",
      "prose",
    ]);
  });

  it("does not treat headings inside fenced code as structure", () => {
    const md = [
      "## Purpose",
      "```md",
      "### Requirement: Not real",
      "```",
      "after",
    ].join("\n");
    expect(requirements(md)).toHaveLength(0);
    const prose = parseSpec(md).filter((b) => b.type === "prose");
    expect(prose[0].markdown).toContain("### Requirement: Not real");
  });

  it("keeps a fenced block that is inside a requirement body", () => {
    const md = [
      "### Requirement: Config",
      "Example:",
      "```yaml",
      "## not a heading",
      "```",
      "#### Scenario: s",
      "- **THEN** ok",
    ].join("\n");
    const [req] = requirements(md);
    expect(req.markdown).toContain("## not a heading");
    expect(req.scenarios).toHaveLength(1);
  });

  it("returns nothing for an empty document", () => {
    expect(parseSpec("")).toEqual([]);
  });
});

describe("parseTasks", () => {
  it("groups checkboxes under their headings and counts progress", () => {
    const md = [
      "## 1. Backend",
      "- [x] 1.1 Add users table",
      "- [ ] 1.2 Add login endpoint",
      "## 2. Frontend",
      "- [ ] 2.1 Login form",
    ].join("\n");

    const doc = parseTasks(md);
    expect(doc.done).toBe(1);
    expect(doc.total).toBe(3);
    expect(doc.groups.map((g) => g.title)).toEqual(["1. Backend", "2. Frontend"]);
    expect(doc.groups[0].items).toEqual([
      { done: true, text: "1.1 Add users table" },
      { done: false, text: "1.2 Add login endpoint" },
    ]);
  });

  it("accepts uppercase X and asterisk bullets", () => {
    const doc = parseTasks("* [X] done\n* [ ] open\n");
    expect([doc.done, doc.total]).toEqual([1, 2]);
  });

  it("handles ungrouped tasks with no heading", () => {
    const doc = parseTasks("- [ ] just one\n");
    expect(doc.groups).toEqual([
      { title: null, items: [{ done: false, text: "just one" }] },
    ]);
  });

  it("keeps non-task prose as notes rather than dropping it", () => {
    const doc = parseTasks("## Plan\nSome context.\n- [ ] a task\n");
    expect(doc.total).toBe(1);
    expect(doc.notes).toContain("Some context.");
  });

  it("reports zero progress for a document with no checkboxes", () => {
    const doc = parseTasks("## Plan\nNothing actionable yet.\n");
    expect([doc.done, doc.total]).toEqual([0, 0]);
  });
});

describe("outline", () => {
  it("lists sections and requirements in document order", () => {
    const md = [
      "# billing Specification",
      "## Requirements",
      "### Requirement: Invoice generation",
      "text",
      "#### Scenario: skipped",
      "### Requirement: Refunds",
      "text",
    ].join("\n");

    expect(outline(md).map((h) => h.text)).toEqual([
      "billing Specification",
      "Requirements",
      "Invoice generation",
      "Refunds",
    ]);
  });
});

describe("slugify", () => {
  it("makes stable anchors from requirement names", () => {
    expect(slugify("Email login")).toBe("email-login");
    expect(slugify("OAuth 2.0 / PKCE")).toBe("oauth-2-0-pkce");
    expect(slugify("`code` name")).toBe("code-name");
  });
});
