import { useState } from "react";
import type { ChangeNode, Doc, ProjectTree, SpecNode } from "../lib/types";
import { progressLabel } from "../lib/artifact";

/** Every spec in the tree, flattened, with its requirement count. */
function flatSpecs(nodes: SpecNode[]): SpecNode[] {
  return nodes.flatMap((n) => [...(n.doc ? [n] : []), ...flatSpecs(n.children)]);
}

function sectionItems(tree: ProjectTree) {
  let active: ChangeNode[] = [];
  let archive: ChangeNode[] = [];
  let specs: SpecNode[] = [];

  for (const section of tree.sections) {
    if (section.kind === "activeChanges") active = section.items;
    if (section.kind === "archive") archive = section.items;
    if (section.kind === "specs") specs = flatSpecs(section.items);
  }
  return { active, archive, specs };
}

/** The step a change is on, which is the useful thing to say about it. */
function standing(change: ChangeNode): string {
  const current = change.artifacts.find((a) => a.state === "current");
  if (current) return `on ${current.label.toLowerCase()}`;
  return change.artifacts.every((a) => a.state === "complete")
    ? "every step settled"
    : "not started";
}

type Pane = "active" | "specs" | "archive";

function Card({
  label,
  count,
  note,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  note: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className="card"
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="card__label">{label}</span>
      <span className="card__count">{count}</span>
      <span className="card__note">{note}</span>
    </button>
  );
}

function ChangeRows({
  changes,
  onOpenChange,
  dated,
}: {
  changes: ChangeNode[];
  onOpenChange: (name: string) => void;
  dated?: boolean;
}) {
  return (
    <ul className="home__changes">
      {changes.map((change) => {
        const progress = progressLabel(change);
        return (
          <li key={change.name}>
            <button className="home__change" onClick={() => onOpenChange(change.name)}>
              <span className="home__change-name">{change.name}</span>
              <span className="home__change-standing">
                {dated ? (change.archivedOn ?? "archived") : standing(change)}
              </span>
              {progress && <span className="progress">{progress}</span>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The project at a glance.
 *
 * The three counts are the selector: whichever is chosen is what the list
 * beneath shows. That way nothing needs a section of its own competing for the
 * top of the page, and the numbers lead somewhere instead of decorating.
 */
export function ProjectDashboard({
  tree,
  onOpenDoc,
  onOpenChange,
  onNewChange,
}: {
  tree: ProjectTree;
  onOpenDoc: (doc: Doc) => void;
  onOpenChange: (name: string) => void;
  onNewChange: () => void;
}) {
  const { active, archive, specs } = sectionItems(tree);
  const [pane, setPane] = useState<Pane>(active.length > 0 ? "active" : "specs");

  const requirements = specs.reduce((n, s) => n + (s.requirementCount ?? 0), 0);
  const tasksDone = active.reduce((n, c) => n + (c.completedTasks ?? 0), 0);
  const tasksTotal = active.reduce((n, c) => n + (c.totalTasks ?? 0), 0);

  return (
    <div className="reader">
      <div className="dash">
        <header className="dash__head">
          <div>
            <h1 className="dash__name">{tree.name}</h1>
          </div>
          <div className="dash__actions">
            <button className="button" onClick={onNewChange}>
              New change
            </button>
          </div>
        </header>

        <div className="cards">
          <Card
            label="Active changes"
            count={active.length}
            note={
              tasksTotal > 0
                ? `${tasksDone} of ${tasksTotal} tasks done`
                : "no tasks written yet"
            }
            selected={pane === "active"}
            onSelect={() => setPane("active")}
          />
          <Card
            label="Open specs"
            count={specs.length}
            note={
              requirements > 0 ? `${requirements} requirements` : "no requirements yet"
            }
            selected={pane === "specs"}
            onSelect={() => setPane("specs")}
          />
          <Card
            label="Archived"
            count={archive.length}
            note={
              archive[0]?.archivedOn
                ? `latest ${archive[0].archivedOn}`
                : "nothing archived"
            }
            selected={pane === "archive"}
            onSelect={() => setPane("archive")}
          />
        </div>

        {pane === "active" && (
          <section className="dash__section">
            {active.length === 0 ? (
              <p className="dash__empty">
                Nothing in progress. Start one and Claude will write its
                proposal, specs, design and tasks.
              </p>
            ) : (
              <ChangeRows changes={active} onOpenChange={onOpenChange} />
            )}
          </section>
        )}

        {pane === "specs" && (
          <section className="dash__section">
            {specs.length === 0 ? (
              <p className="dash__empty">
                No specs yet. They arrive when a change is archived and its
                deltas are folded in.
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
                        <span className="home__spec-count">
                          {spec.requirementCount}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {pane === "archive" && (
          <section className="dash__section">
            {archive.length === 0 ? (
              <p className="dash__empty">
                Nothing archived yet. A change is archived once its work is done
                and its specs are folded in.
              </p>
            ) : (
              <ChangeRows changes={archive} onOpenChange={onOpenChange} dated />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
