import { useCallback, useEffect, useRef, useState } from "react";
import {
  PANE,
  clear,
  collectText,
  matchOffsets,
  paint,
  rangeAt,
  reveal,
} from "../lib/find";

interface Props {
  /** Bumped every time ⌘F is pressed, to put the cursor back in the field
   *  when the bar is already open. */
  focusNonce: number;
  /** Changes when the pane switches to another document or view. */
  contentKey: string;
  onClose: () => void;
}

/** How long to wait for a rewrite to settle before searching it again. */
const SETTLE_MS = 120;

/**
 * Find in the open view: the reader, or whichever dashboard is showing.
 *
 * Matches are painted, not wrapped — see `lib/find` — so nothing here writes
 * to the pane it is searching.
 */
export function FindBar({ focusNonce, contentKey, onClose }: Props) {
  const field = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [at, setAt] = useState(0);
  /** Bumped when the pane's text changes under the search. */
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [focusNonce]);

  // An agent writing to the open file re-renders the pane, which detaches
  // every range found in it. Watching the pane catches that, and the content
  // a dashboard loads after its first paint, rather than trusting a render to
  // be the only way the text can change.
  useEffect(() => {
    const pane = document.querySelector(PANE);
    if (!pane) return;
    let timer = 0;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setRevision((r) => r + 1), SETTLE_MS);
    });
    observer.observe(pane, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [contentKey]);

  const lastKey = useRef(contentKey);
  useEffect(() => {
    const switched = lastKey.current !== contentKey;
    lastKey.current = contentKey;

    const pane = document.querySelector(PANE);
    if (!pane || !query) {
      setMatches([]);
      setAt(0);
      return;
    }
    const map = collectText(pane);
    const found = matchOffsets(map.text, query)
      .map((offset) => rangeAt(map, offset, query.length))
      .filter((range): range is Range => range !== null);
    setMatches(found);
    // A rewrite of the open document keeps your place; moving to another
    // document starts again at the first match.
    setAt((previous) => {
      const from = switched ? 0 : previous;
      return found.length === 0 ? 0 : Math.min(from, found.length - 1);
    });
  }, [query, contentKey, revision]);

  useEffect(() => {
    if (matches.length === 0) {
      clear();
      return;
    }
    paint(matches, at);
    const pane = document.querySelector(PANE);
    const range = matches[at];
    if (pane && range) reveal(pane, range);
  }, [matches, at]);

  // Closing must leave nothing painted behind it.
  useEffect(() => () => clear(), []);

  const step = useCallback(
    (by: number) =>
      setAt((previous) =>
        matches.length === 0
          ? 0
          : (previous + by + matches.length) % matches.length,
      ),
    [matches.length],
  );

  // Escape closes wherever the focus is, and ⌘G steps on — both are expected
  // to work after clicking into the document itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  const empty = matches.length === 0;

  return (
    <div className="find" role="search">
      <input
        ref={field}
        className="find__field"
        type="text"
        placeholder="Find"
        aria-label="Find in view"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }}
      />
      <span className="find__count" role="status">
        {query === "" ? "" : empty ? "No results" : `${at + 1} of ${matches.length}`}
      </span>
      <button
        className="find__step"
        onClick={() => step(-1)}
        disabled={empty}
        aria-label="Previous match"
        title="Previous match (⇧⌘G)"
      >
        ↑
      </button>
      <button
        className="find__step"
        onClick={() => step(1)}
        disabled={empty}
        aria-label="Next match"
        title="Next match (⌘G)"
      >
        ↓
      </button>
      <button
        className="find__close"
        onClick={onClose}
        aria-label="Close find"
        title="Close (Esc)"
      >
        ✕
      </button>
    </div>
  );
}
