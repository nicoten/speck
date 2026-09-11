/**
 * Find in the open view.
 *
 * A Tauri window has no find bar of its own — WKWebView does not expose one —
 * so Specks builds it. The offset arithmetic is kept separate from the DOM glue
 * below it, so the part that gets a match wrong can be tested without a
 * browser.
 */

/** All three main-pane views — the reader and both dashboards — render this as
 *  their scrolling root, so it is the whole of what find has to resolve. */
export const PANE = ".reader";

/** Case-folded copy of the same length as its input. A few characters ("İ")
 *  lowercase to two, and a length change there would slide every offset after
 *  it, putting the highlight a character off for the rest of the document. */
function fold(text: string): string {
  let out = "";
  for (const character of text) {
    const lower = character.toLowerCase();
    out += lower.length === character.length ? lower : character;
  }
  return out;
}

/**
 * Offsets of every match of `query` in `text`: literal and case-insensitive.
 * Literal because these documents are prose and code — a query of `(WHEN` is
 * something to search for, not a broken regex.
 *
 * Matches never overlap: "aa" in "aaaa" is two matches, not three, because a
 * count of matches has to mean a count of highlights.
 */
export function matchOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = fold(text);
  const needle = fold(query);
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    found.push(at);
  }
  return found;
}

/**
 * Where an offset in the joined text falls: which node, and how far into it.
 * An offset on a boundary belongs to the node that begins there, so a match
 * starting at a node's first character anchors inside it rather than at the
 * end of the node before.
 */
export function locate(
  starts: number[],
  offset: number,
): { index: number; offset: number } {
  if (starts.length === 0) return { index: -1, offset: 0 };
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { index: low, offset: offset - starts[low] };
}

export interface TextMap {
  /** Every searchable text node in the pane, joined. */
  text: string;
  nodes: Text[];
  /** Offset in `text` at which each node's text begins. */
  starts: number[];
}

const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT"]);

/** The pane's text, flattened, with the map back to the nodes it came from. */
export function collectText(root: Element): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || IGNORED_TAGS.has(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      // The outline repeats every heading in the document. Searching it would
      // count each heading twice and step through a sidebar copy of a match
      // whose real place in the prose is somewhere else.
      if (parent.closest(".outline")) return NodeFilter.FILTER_REJECT;
      return node.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    starts.push(text.length);
    nodes.push(node as Text);
    text += node.nodeValue;
  }
  return { text, nodes, starts };
}

/** A range over the match at `offset`, which spans several nodes when the
 *  phrase runs through inline markup. */
export function rangeAt(
  map: TextMap,
  offset: number,
  length: number,
): Range | null {
  const from = locate(map.starts, offset);
  // Addressed by the match's last character rather than the position past it,
  // so the end never lands beyond the node it belongs to.
  const to = locate(map.starts, offset + length - 1);
  if (from.index < 0 || to.index < 0) return null;
  const range = document.createRange();
  range.setStart(map.nodes[from.index], from.offset);
  range.setEnd(map.nodes[to.index], to.offset + 1);
  return range;
}

const ALL = "specks-find";
const CURRENT = "specks-find-current";

/** Whether matches can be painted without being put into the DOM. */
function canHighlight(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

/**
 * Show `ranges`, with the one at `current` marked.
 *
 * The CSS Custom Highlight API paints ranges without touching the DOM, which
 * is what this needs: the pane is React's, and the watcher re-renders it
 * whenever an agent writes to the open file, so `<mark>` elements wrapped
 * around matches would be fighting reconciliation on every write.
 */
export function paint(ranges: Range[], current: number): void {
  const at = ranges[current];
  if (!canHighlight()) {
    // Without the API, the document's own selection can still show where you
    // are — one match instead of all of them.
    const selection = window.getSelection();
    selection?.removeAllRanges();
    if (at) selection?.addRange(at);
    return;
  }

  const all = new Highlight();
  for (const range of ranges) all.add(range);
  CSS.highlights.set(ALL, all);

  const only = new Highlight();
  if (at) only.add(at);
  only.priority = 1;
  CSS.highlights.set(CURRENT, only);
}

export function clear(): void {
  if (canHighlight()) {
    CSS.highlights.delete(ALL);
    CSS.highlights.delete(CURRENT);
    return;
  }
  window.getSelection()?.removeAllRanges();
}

/** How much of the pane to keep between a match and the edge of the view. */
const MARGIN = 96;

/** Bring a match into view, but only when it is not already comfortably in it:
 *  re-centring on every step makes stepping through neighbouring matches
 *  lurch, and the pane has a sticky header a match can hide under. */
export function reveal(pane: Element, range: Range): void {
  const match = range.getBoundingClientRect();
  if (match.width === 0 && match.height === 0) return;
  const view = pane.getBoundingClientRect();
  if (match.top >= view.top + MARGIN && match.bottom <= view.bottom - MARGIN) {
    return;
  }
  const centred =
    pane.scrollTop + (match.top - view.top) - view.height / 2 + match.height / 2;
  pane.scrollTo({ top: Math.max(0, centred) });
}
