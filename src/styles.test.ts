/// <reference types="node" />
// Structural guards for the stylesheet.
//
// Editing this file by text range has twice deleted rules that happened to sit
// next to the target — once the @font-face imports, once the reader's layout
// block — and both times the app still built and every other test still passed.
// These assertions fail loudly instead.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Read from disk rather than importing: Vitest stubs CSS modules, so an import
// would hand back an empty string and every assertion here would pass on
// nothing.
const css = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
);

/**
 * The body of a rule, so a property can be checked against its own selector.
 * Anchored to the start of a line: `.doc` must not match the `.doc` inside
 * `.reader__body[data-source="true"] .doc`.
 */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A selector may head a group, so it can be followed by a comma as well as a
  // brace.
  const at = css.search(new RegExp(`^${escaped}\\s*[,{]`, "m"));
  expect(at, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

it("reads the real stylesheet, not an empty stub", () => {
  expect(css.length).toBeGreaterThan(4000);
});

describe("fonts", () => {
  it("bundles every weight the design uses, so the app works offline", () => {
    for (const weight of ["400", "400-italic", "500", "600"]) {
      expect(css).toContain(`@fontsource/ibm-plex-mono/${weight}.css`);
    }
  });

  it("keeps a real fallback stack behind the webfont", () => {
    expect(rule(":root")).toMatch(/--mono:\s*"IBM Plex Mono",[^;]*monospace/);
    expect(rule(":root")).toMatch(/--sans:[^;]*sans-serif/);
  });
});

describe("palette", () => {
  it("defines the openspec.dev base and accent", () => {
    const root = rule(":root");
    expect(root).toContain("--paper: #f2efe3");
    expect(root).toContain("--ink: #33322f");
    expect(root).toContain("--accent: #c96f4b");
  });

  it("redefines the palette for dark mode", () => {
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
    for (const token of ["--paper:", "--ink:", "--accent:", "--op-added:"]) {
      expect(dark).toContain(token);
    }
  });

  it("gives every delta operation a colour and a ground", () => {
    const root = rule(":root");
    for (const op of ["added", "modified", "removed", "renamed"]) {
      expect(root).toContain(`--op-${op}:`);
      expect(root).toContain(`--op-${op}-bg:`);
    }
  });
});

describe("reader layout", () => {
  it("insets and constrains the reading column", () => {
    const body = rule(".reader__body");
    expect(body).toContain("display: grid");
    // Side padding is what went missing; without it the text hugs the divider.
    expect(body).toMatch(/padding:[^;]*40px/);
    expect(body).toContain("var(--reading-measure)");
  });

  it("holds the document to a measure", () => {
    expect(rule(".doc")).toContain("max-width: var(--reading-measure)");
  });

  it("lets source files use a wider measure than prose", () => {
    expect(css).toContain('.reader__body[data-source="true"]');
  });

  it("gives the outline its own column on wide windows", () => {
    expect(css).toContain('.reader__body[data-outline="true"]');
    expect(css).toContain("@media (min-width: 1180px)");
  });
});

describe("current-document marker", () => {
  it("marks the open document with the accent in all three places", () => {
    for (const selector of ['.row[aria-current="true"]', '.file[aria-current="true"]']) {
      expect(rule(selector)).toContain("var(--accent)");
    }
    expect(rule('.stepper__step[aria-current="true"] .stepper__dot')).toContain(
      "var(--accent",
    );
  });
});

describe("stepper", () => {
  it("distinguishes settled, current and not-started steps", () => {
    expect(
      rule('.stepper__step[data-state="complete"] .stepper__dot'),
    ).toContain("var(--op-added)");
    // A step not started keeps the faint ring.
    expect(rule(".stepper__dot")).toContain("var(--rule-strong)");
  });

  it("keeps the filled ground behind the steps", () => {
    expect(rule(".stepper__fill")).toContain("position: absolute");
    expect(rule(".stepper__fill")).toContain("var(--op-added-bg)");
    expect(rule(".stepper__step")).toContain("z-index: 1");
  });

  it("stays one compact bar", () => {
    const bar = rule(".stepper");
    expect(bar).toContain("border-radius: 999px");
    expect(bar).toContain("max-width: var(--reading-measure)");
  });
});

describe("update notice", () => {
  it("reads as an offer rather than an alarm", () => {
    expect(rule(".update")).toContain("var(--accent-border)");
    expect(rule(".update__action")).toContain("var(--accent-strong)");
  });
});

describe("agent handoff", () => {
  it("keeps the apply action beside the progress bar", () => {
    expect(rule(".changebar")).toContain("display: flex");
    expect(rule(".changebar__apply")).toContain("flex: none");
  });

  it("distinguishes a live session from a finished or failed one", () => {
    expect(rule(".agent__dot--live")).toContain("var(--op-added)");
    expect(rule('.agent[data-status="failed"] .agent__dot')).toContain("var(--op-removed)");
  });

  it("keeps the session log above the reading rail, not over the document", () => {
    const agent = rule(".agent");
    expect(agent).toContain("border-top");
    expect(agent).toContain("max-height");
    expect(rule(".agent__log")).toContain("overflow-y: auto");
  });

  it("marks refusals distinctly from failures", () => {
    expect(rule(".agent__denials")).toContain("var(--op-modified)");
    expect(rule(".agent__failure")).toContain("var(--op-removed)");
  });

  it("gives the run sheet a focus ring and a readable field", () => {
    expect(rule(".sheet__field:focus-visible")).toContain("var(--accent)");
    expect(rule(".sheet__panel")).toContain("var(--paper)");
  });
});

describe("responsiveness", () => {
  it("keeps a side gutter at phone width", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(narrow).toContain(".reader__body");
    expect(narrow).toMatch(/20px/);
  });

  it("respects reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
