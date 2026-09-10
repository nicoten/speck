import type { DocRef } from "../lib/order";

interface Props {
  prev: DocRef | null;
  next: DocRef | null;
  index: number;
  total: number;
  onGo: (ref: DocRef) => void;
}

/** Page-turning through the project's reading sequence. */
export function ReadingRail({ prev, next, index, total, onGo }: Props) {
  return (
    <div className="readingrail">
      <button
        className="readingrail__step"
        onClick={() => prev && onGo(prev)}
        disabled={!prev}
        title={prev ? `Previous: ${prev.doc.title}` : "Start of the project"}
      >
        <span aria-hidden="true">‹</span>
        <span className="readingrail__title">{prev ? prev.doc.title : "Start"}</span>
      </button>

      <span className="readingrail__position">
        {index >= 0 ? `${index + 1} of ${total}` : `${total} documents`}
      </span>

      <button
        className="readingrail__step readingrail__step--next"
        onClick={() => next && onGo(next)}
        disabled={!next}
        title={next ? `Next: ${next.doc.title}` : "End of the project"}
      >
        <span aria-hidden="true">›</span>
        <span className="readingrail__title">{next ? next.doc.title : "End"}</span>
      </button>
    </div>
  );
}
