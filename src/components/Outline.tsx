import { outline } from "../lib/markdown/parse";

/** In-document outline. Anchors come from the same parser that renders the
 *  document, so every entry resolves. */
export function Outline({ markdown }: { markdown: string }) {
  const headings = outline(markdown);
  if (headings.length < 3) return null;

  return (
    <nav className="outline" aria-label="In this document">
      <p className="outline__title">In this document</p>
      <ul className="outline__list">
        {headings.map((h) => (
          <li key={h.anchor} className={`outline__item outline__item--l${h.level}`}>
            <a href={`#${h.anchor}`}>{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
