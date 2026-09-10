import type { ChangeNode, Doc, ProjectTree, SpecNode } from "../lib/types";
import { progressLabel } from "../lib/artifact";

/** Every spec in the tree, flattened, with its requirement count. */
function flatSpecs(nodes: SpecNode[]): SpecNode[] {
  return nodes.flatMap((n) => [
    ...(n.doc ? [n] : []),
    ...flatSpecs(n.children),
  ]);
}

function sectionItems(tree: ProjectTree) {
  const context: Doc[] = [];
  let active: ChangeNode[] = [];
  let archive: ChangeNode[] = [];
  let specs: SpecNode[] = [];

  for (const section of tree.sections) {
    if (section.kind === "project") context.push(...section.items);
    if (section.kind === "activeChanges") active = section.items;
    if (section.kind === "archive") archive = section.items;
    if (section.kind === "specs") specs = flatSpecs(section.items);
  }
  return { context, active, archive, specs };
}

/** The step a change is on, which is the useful thing to say about it. */
function standing(change: ChangeNode): string {
  const current = change.artifacts.find((a) => a.state === "current");
  if (current) return `on ${current.label.toLowerCase()}`;
  const allDone = change.artifacts.every((a) => a.state === "complete");
  return allDone ? "every step settled" : "not started";
}

/**
 * The project at a glance, and where reading starts.
 *
 * This is the home view because `config.yaml` was a poor first thing to see:
 * it is the least interesting file in an OpenSpec project, and it opened by
 * accident of being first in the reading order.
 */
export function ProjectDashboard({
  tree,
  onOpenDoc,
  onOpenChange,
  onNewChange,
  onStartReading,
}: {
  tree: ProjectTree;
  onOpenDoc: (doc: Doc) => void;
  onOpenChange: (name: string) => void;
  onNewChange: () => void;
  onStartReading: () => void;
}) {
  const { context, active, archive, specs } = sectionItems(tree);
  const requirements = specs.reduce((n, s) => n + (s.requirementCount ?? 0), 0);

  return (
    <div className="reader">
      <div className="dash">
        <header className="dash__head">
          <div>
            <h1 className="dash__name">{tree.name}</h1>
            <p className="dash__meta">
              {/* The schema decides the order everything is read in, so it is
                  worth one plain sentence rather than a label in the chrome. */}
              Reads{" "}
              {tree.schema.artifacts.map((a) => a.id).join(" → ") ||
                "in schema order"}
              {tree.schema.assumed && " (assumed — the schema could not be read)"}
            </p>
          </div>
          <div className="dash__actions">
            <button className="button" onClick={onNewChange}>
              New change
            </button>
          </div>
        </header>

        <section className="dash__section">
          <h2 className="dash__h2">
            In progress
            <span className="dash__count">{active.length}</span>
          </h2>
          {active.length === 0 && (
            <p className="dash__empty">
              Nothing in progress. Start one and Claude will write its proposal,
              specs, design and tasks.
            </p>
          )}
          <ul className="home__changes">
            {active.map((change) => {
              const progress = progressLabel(change);
              return (
                <li key={change.name}>
                  <button
                    className="home__change"
                    onClick={() => onOpenChange(change.name)}
                  >
                    <span className="home__change-name">{change.name}</span>
                    <span className="home__change-standing">{standing(change)}</span>
                    {progress && <span className="progress">{progress}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="dash__section">
          <h2 className="dash__h2">
            Specified today
            <span className="dash__count">
              {specs.length} {specs.length === 1 ? "capability" : "capabilities"}
              {requirements > 0 && `, ${requirements} requirements`}
            </span>
          </h2>
          {specs.length === 0 ? (
            <p className="dash__empty">
              No specs yet. They arrive when a change is archived and its deltas
              are folded in.
            </p>
          ) : (
            <ul className="home__specs">
              {specs.map((spec) => (
                <li key={spec.id}>
                  <button
                    className="home__spec"
                    onClick={() => spec.doc && onOpenDoc(spec.doc)}
                  >
                    <span>{spec.id}</span>
                    {spec.requirementCount !== null && (
                      <span className="home__spec-count">{spec.requirementCount}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="dash__section">
          <h2 className="dash__h2">
            Read it through
            <span className="dash__count">{tree.docCount} documents</span>
          </h2>
          <p className="dash__empty">
            Grouped by where each document sits in the workflow, and numbered so
            it reads front to back.
          </p>
          <div className="home__links">
            <button className="button button--quiet" onClick={onStartReading}>
              Start at the beginning
            </button>
            {context.map((doc) => (
              <button
                key={doc.id}
                className="home__link"
                onClick={() => onOpenDoc(doc)}
              >
                {doc.title}
              </button>
            ))}
          </div>
        </section>

        {archive.length > 0 && (
          <section className="dash__section">
            <h2 className="dash__h2">
              Archived
              <span className="dash__count">{archive.length}</span>
            </h2>
            <ul className="home__changes">
              {archive.slice(0, 5).map((change) => (
                <li key={change.name}>
                  <button
                    className="home__change"
                    onClick={() => onOpenChange(change.name)}
                  >
                    <span className="home__change-name">{change.name}</span>
                    <span className="home__change-standing">
                      {change.archivedOn ?? "archived"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
