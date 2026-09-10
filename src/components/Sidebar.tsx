import { isComplete, progressLabel } from "../lib/artifact";
import { ArtifactTrail } from "./ArtifactTrail";
import {
  SECTION_LABELS,
  type ArtifactGroup,
  type ChangeNode,
  type Doc,
  type ProjectTree,
  type Section,
  type SpecNode,
} from "../lib/types";

interface Props {
  tree: ProjectTree;
  openPath: string | null;
  onOpen: (doc: Doc) => void;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}

interface SidebarProps extends Props {
  onNewChange: () => void;
}

function Progress({ of }: { of: ChangeNode }) {
  const label = progressLabel(of);
  if (!label) return null;
  return (
    <span className={`progress${isComplete(of) ? " progress--complete" : ""}`}>
      {label}
    </span>
  );
}

/**
 * A change, its schema artifacts, and the files under each.
 *
 * The step rail threads the *artifacts* — proposal, specs, design, tasks — which
 * is the level the schema defines. Files hang off the artifact they satisfy, so
 * a multi-file artifact like `specs` no longer sits flat beside `design.md`.
 */
function Change({
  change,
  keyPrefix,
  openPath,
  onOpen,
  collapsed,
  onToggle,
}: {
  change: ChangeNode;
  keyPrefix: string;
} & Omit<Props, "tree">) {
  const key = `${keyPrefix}:${change.name}`;
  const isOpen = !collapsed.has(key);

  return (
    <div>
      <button className="row" onClick={() => onToggle(key)} aria-expanded={isOpen}>
        <span className="disclosure" aria-hidden="true">
          {isOpen ? "▾" : "▸"}
        </span>
        <span className="row__label">{change.name}</span>
        <span className="row__trail">
          {/* Archived changes show their date; an active one shows progress
              only while closed, since its Tasks row carries it once open. */}
          {change.archivedOn ? (
            <span>{change.archivedOn}</span>
          ) : (
            !isOpen && <Progress of={change} />
          )}
        </span>
      </button>

      {isOpen && (
        <div className="change__docs">
          {change.artifacts.map((group) => (
            <ArtifactRow
              key={group.id}
              group={group}
              changeKey={key}
              openPath={openPath}
              onOpen={onOpen}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One schema artifact. A nested artifact (`specs`) discloses its capability
 * paths; a single-file one (`proposal`, `design`, `tasks`) is the document
 * itself, since its label already names the file.
 */
function ArtifactRow({
  group,
  changeKey,
  openPath,
  onOpen,
  collapsed,
  onToggle,
}: {
  group: ArtifactGroup;
  changeKey: string;
} & Omit<Props, "tree">) {
  const key = `${changeKey}:${group.id}`;
  const isOpen = !collapsed.has(key);
  const holdsOpenDoc = group.docs.some((d) => d.path === openPath);
  const leaf = group.nested ? null : (group.docs[0] ?? null);

  return (
    <div className="artifact">
      {/* The schema step number is the only marker these rows need; the files
          beneath a nested artifact carry none. */}
      <button
        className={`step${group.missing ? " step--missing" : ""}`}
        onClick={() => {
          if (group.missing) return;
          if (leaf) onOpen(leaf);
          else onToggle(key);
        }}
        aria-expanded={group.missing || leaf ? undefined : isOpen}
        aria-current={leaf ? leaf.path === openPath : undefined}
        disabled={group.missing}
        title={
          group.missing
            ? `${group.label} — not written yet`
            : (leaf?.title ?? group.label)
        }
      >
        <span className="step__index">{group.step}</span>
        <span
          className={`step__label${holdsOpenDoc && !isOpen ? " step__label--holds" : ""}`}
        >
          {group.label}
        </span>
        <span className="step__trail">
          {group.missing ? "not written" : <ArtifactTrail group={group} />}
        </span>
      </button>

      {group.nested && isOpen && group.docs.length > 0 && (
        <div className="artifact__files">
          {group.docs.map((doc) => (
            <button
              className="file"
              key={doc.id}
              onClick={() => onOpen(doc)}
              aria-current={doc.path === openPath}
              title={doc.title}
            >
              <span className="file__label">{doc.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SpecRows({
  nodes,
  depth,
  openPath,
  onOpen,
}: {
  nodes: SpecNode[];
  depth: number;
} & Pick<Props, "openPath" | "onOpen">) {
  return (
    <>
      {nodes.map((node) => (
        <div key={node.id}>
          <button
            className={`row${node.doc ? "" : " row--missing"}`}
            style={{ paddingLeft: 14 + depth * 14 }}
            onClick={() => node.doc && onOpen(node.doc)}
            aria-current={node.doc?.path === openPath}
            disabled={!node.doc}
          >
            <span className="row__label">{node.label}</span>
            {node.requirementCount !== null && (
              <span className="row__trail">
                {node.requirementCount} {node.requirementCount === 1 ? "req" : "reqs"}
              </span>
            )}
          </button>
          {node.children.length > 0 && (
            <SpecRows
              nodes={node.children}
              depth={depth + 1}
              openPath={openPath}
              onOpen={onOpen}
            />
          )}
        </div>
      ))}
    </>
  );
}

function count(section: Section): number {
  return section.items.length;
}

function emptyMessage(kind: Section["kind"]): string {
  switch (kind) {
    case "project":
      return "No project documents";
    case "activeChanges":
      return "No changes in progress";
    case "specs":
      return "No specs yet";
    case "archive":
      return "Nothing archived";
  }
}

export function Sidebar({
  tree,
  openPath,
  onOpen,
  collapsed,
  onToggle,
  onNewChange,
}: SidebarProps) {
  return (
    <nav className="sidebar" aria-label="Project documents">
      {tree.sections.map((section) => (
        <div className="section" key={section.kind}>
          <div className="section__head">
            <span className="section__title">{SECTION_LABELS[section.kind]}</span>
            <span className="section__rule" />
            {section.kind === "activeChanges" && (
              <button
                className="section__add"
                onClick={onNewChange}
                title="Plan a new change"
                aria-label="Plan a new change"
              >
                +
              </button>
            )}
            <span className="section__count">{count(section)}</span>
          </div>

          {count(section) === 0 && (
            <p className="section__empty">{emptyMessage(section.kind)}</p>
          )}

          {section.kind === "project" &&
            section.items.map((doc) => (
              <button
                className="row"
                key={doc.id}
                onClick={() => onOpen(doc)}
                aria-current={doc.path === openPath}
              >
                <span className="row__label">{doc.title}</span>
              </button>
            ))}

          {(section.kind === "activeChanges" || section.kind === "archive") &&
            section.items.map((change) => (
              <Change
                key={change.name}
                change={change}
                keyPrefix={section.kind}
                openPath={openPath}
                onOpen={onOpen}
                collapsed={collapsed}
                onToggle={onToggle}
              />
            ))}

          {section.kind === "specs" && (
            <SpecRows
              nodes={section.items}
              depth={0}
              openPath={openPath}
              onOpen={onOpen}
            />
          )}
        </div>
      ))}
    </nav>
  );
}
