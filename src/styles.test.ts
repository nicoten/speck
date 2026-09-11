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

it("is structurally intact", () => {
  // A duplicated block or a split selector list still mostly renders, so
  // neither shows up as a broken app. Both have happened here.
  expect(css.split("{").length).toBe(css.split("}").length);

  const selectors = [...css.matchAll(/^(\.[a-z][\w-]*)\s*\{/gim)].map((m) => m[1]);
  const seen = new Set<string>();
  const twice = selectors.filter((s) => (seen.has(s) ? true : (seen.add(s), false)));
  expect([...new Set(twice)]).toEqual([]);
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

describe("change dashboard", () => {
  it("separates the caret from the name in a change row", () => {
    expect(rule(".row__name")).toContain("flex: 1");
    expect(rule(".row--selected")).toContain("var(--accent)");
  });

  it("gives the caret a hit target and keeps it off the window edge", () => {
    const caret = rule(".disclosure");
    expect(caret).toContain("cursor: pointer");
    // Small carets in a dense tree are the easiest thing in a sidebar to miss.
    for (const dimension of ["width: 22px", "height: 22px"]) {
      expect(caret).toContain(dimension);
    }
    expect(rule(".row--split")).toMatch(/padding:[^;]*8px/);
  });

  it("holds the dashboard to a measure and marks the step in hand", () => {
    expect(rule(".dash")).toContain("max-width");
    expect(rule('.dash__artifact[data-state="current"] .dash__artifact-state')).toContain(
      "var(--accent-strong)",
    );
  });

  it("collapses the artifact table on a narrow window", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 720px)"));
    expect(narrow).toContain(".dash__artifact");
  });
});

describe("forge links", () => {
  it("gives each pull request state the tone people already read", () => {
    expect(rule(".pr__state--open")).toContain("var(--op-added)");
    expect(rule(".pr__state--merged")).toContain("var(--op-renamed)");
    expect(rule(".pr__state--closed")).toContain("var(--op-removed)");
  });

  it("keeps a missing pull request quiet rather than alarming", () => {
    expect(rule(".prs--quiet")).toContain("var(--ink-faint)");
    expect(rule(".prs__basis")).toContain("var(--ink-faint)");
  });

  it("marks the repository link as a link on hover", () => {
    expect(rule(".topbar__repo:hover")).toContain("var(--accent-strong)");
  });

  it("keeps a degraded read visible in the chrome, not buried in a view", () => {
    // Dropping the source readout from the top bar must not hide the scanner
    // fallback, so the notice lives above both views.
    expect(rule(".chrome")).toContain("border-bottom");
    expect(rule(".notice")).toContain("var(--op-modified)");
  });
});

describe("task checkboxes", () => {
  it("makes a live box look like a control and a done one look done", () => {
    expect(rule(".taskbox--live")).toContain("cursor: pointer");
    expect(rule(".taskbox--live:hover")).toContain("var(--accent)");
    expect(rule(".taskbox--done")).toContain("var(--op-added)");
  });

  it("shows un-ticking as reversible rather than inert", () => {
    expect(rule(".taskbox--live.taskbox--done:hover")).toContain("opacity");
  });
});

describe("project overview", () => {
  it("makes the overview row reachable and markable", () => {
    expect(rule(".row--home")).toContain("font-weight: 600");
  });

  it("keeps the three counts on one row", () => {
    expect(rule(".cards")).toContain("repeat(3, minmax(0, 1fr))");
  });

  it("reads the counts as a readout, with no interactive state", () => {
    // Navigation belongs to the sidebar; a card that looked clickable but was
    // not would be worse than a plain number.
    expect(css).not.toContain('.card[aria-pressed');
    expect(css).not.toContain(".card:hover");
  });

  it("keeps the primary action at the trailing edge", () => {
    const actions = rule(".dash__actions");
    expect(actions).toContain("margin-left: auto");
    // Without this it stretches instead: the heading's `flex: 1` rule used to
    // match this element too, and out-specified it.
    expect(actions).toContain("flex: none");
    expect(css).not.toContain(".dash__head > div {");
  });
});

describe("workflow actions", () => {
  it("keeps the three workflow buttons on one row", () => {
    expect(rule(".dash__actions")).toContain("display: flex");
    expect(rule(".dash__actions")).toContain("flex-wrap: wrap");
  });
});

describe("agent handoff", () => {
  it("states where the session runs", () => {
    expect(rule(".sheet__note")).toContain("var(--accent-border)");
    expect(css).not.toContain(".sheet__check");
    expect(css).not.toContain(".agent__log");
  });

  it("gives the pull request title the row to itself", () => {
    expect(rule(".pr__title")).toContain("min-width: 0");
    expect(rule(".pr")).toContain("width: 100%");
  });

  it("states where the session runs instead of offering modes", () => {
    expect(rule(".sheet__note")).toContain("var(--accent-border)");
    expect(css).not.toContain(".sheet__check");
    // The in-app session panel is gone; work runs in a terminal.
    expect(css).not.toContain(".agent__log");
  });

  it("gives the pull request title the row to itself", () => {
    expect(rule(".pr__title")).toContain("min-width: 0");
    expect(rule(".pr")).toContain("width: 100%");
  });
});

describe("find bar", () => {
  it("overlays the pane instead of taking a column of the grid", () => {
    // The bar is a child of the panes' grid. Without being positioned it would
    // become a fourth grid item and squeeze the reader.
    expect(rule(".find")).toContain("position: absolute");
    expect(rule(".middle")).toContain("position: relative");
  });

  it("marks the current match with the accent and the rest more quietly", () => {
    expect(rule("::highlight(specks-find)")).toContain("var(--op-modified-bg)");
    expect(rule("::highlight(specks-find-current)")).toContain("var(--accent)");
  });

  it("holds the count to a width, so typing does not shift the row", () => {
    expect(rule(".find__count")).toContain("min-width");
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
