import { parseSpec, type DeltaOp, type SpecBlock } from "../lib/markdown/parse";
import { Markdown } from "./Markdown";

const OP_CLASS: Record<DeltaOp, string> = {
  ADDED: "added",
  MODIFIED: "modified",
  REMOVED: "removed",
  RENAMED: "renamed",
};

function Op({ op }: { op: DeltaOp }) {
  return <span className={`op op--${OP_CLASS[op]}`}>{op}</span>;
}

function Block({ block }: { block: SpecBlock }) {
  if (block.type === "prose") return <Markdown>{block.markdown}</Markdown>;

  if (block.type === "heading") {
    const Tag = `h${Math.min(block.level, 4)}` as "h1" | "h2" | "h3" | "h4";
    return <Tag id={block.anchor}>{block.text}</Tag>;
  }

  const opClass = block.op ? ` requirement--${OP_CLASS[block.op]}` : "";
  return (
    <section className={`requirement${opClass}`}>
      <div className="requirement__head">
        {block.op && <Op op={block.op} />}
        <h3 className="requirement__name" id={block.anchor}>
          {block.name}
        </h3>
        <a className="requirement__anchor" href={`#${block.anchor}`} aria-label="Link to this requirement">
          #
        </a>
      </div>
      <Markdown>{block.markdown}</Markdown>
      {block.scenarios.map((scenario) => (
        <div className="scenario" key={scenario.anchor}>
          <h4 className="scenario__name" id={scenario.anchor}>
            {scenario.name}
          </h4>
          <div className="scenario__body">
            <Markdown>{scenario.markdown}</Markdown>
          </div>
        </div>
      ))}
    </section>
  );
}

/** A spec or delta spec, with requirements and scenarios as real blocks. */
export function SpecView({ markdown }: { markdown: string }) {
  const blocks = parseSpec(markdown);
  return (
    <>
      {blocks.map((block, i) => (
        <Block block={block} key={i} />
      ))}
    </>
  );
}
