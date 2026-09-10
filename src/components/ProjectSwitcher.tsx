import { useEffect, useRef, useState } from "react";
import type { ProjectEntry } from "../lib/types";

interface Props {
  projects: ProjectEntry[];
  current: string | null;
  currentName: string;
  onSelect: (path: string) => void;
  onAdd: () => void;
  onRemove: (path: string) => void;
}

export function ProjectSwitcher({
  projects,
  current,
  currentName,
  onSelect,
  onAdd,
  onRemove,
}: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="switcher" ref={box}>
      <button
        className="switcher__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span>{currentName}</span>
        <span className="switcher__chevron" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="switcher__menu" role="menu">
          {projects.map((p) => (
            <div key={p.path} className="switcher__row">
              <button
                className={`switcher__item${p.available ? "" : " switcher__item--stale"}`}
                role="menuitem"
                aria-current={p.path === current}
                onClick={() => {
                  setOpen(false);
                  onSelect(p.path);
                }}
              >
                <span>{p.name}</span>
                {p.storeId && <span className="switcher__badge">store</span>}
                <span className="switcher__item-path">
                  {p.available ? p.path : "missing"}
                </span>
              </button>
              {/* A sibling, not a child: a button inside a button is invalid
                  and unreachable by keyboard. */}
              <button
                className="switcher__remove"
                aria-label={`Forget ${p.name}`}
                onClick={() => onRemove(p.path)}
              >
                ✕
              </button>
            </div>
          ))}

          {projects.length > 0 && <div className="switcher__divider" />}

          <button
            className="switcher__action"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            Open a project folder…
          </button>
        </div>
      )}
    </div>
  );
}
