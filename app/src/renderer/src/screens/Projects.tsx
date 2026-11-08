import { useEffect, useMemo, useState } from "react";
import type { Candidate, ToolId } from "../../../engine/types.js";

const SRC: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor", codex: "Codex" };

function relative(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 864e5);
  if (days <= 0) return "היום";
  if (days === 1) return "אתמול";
  if (days < 30) return `לפני ${days} ימים`;
  if (days < 365) return `לפני ${Math.round(days / 30)} חודשים`;
  return `לפני יותר משנה`;
}

export function Projects({ tools, onBack, onNext }: { tools: ToolId[]; onBack: () => void; onNext: (chosen: Candidate[]) => void }) {
  const [all, setAll] = useState<Candidate[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [showOld, setShowOld] = useState(false);

  const desktopTools = tools.filter((t) => ["claude-code", "cursor", "codex"].includes(t));

  useEffect(() => {
    window.tm.discover(desktopTools).then((c) => {
      setAll(c);
      setChecked(new Set(c.filter((x) => x.active).map((x) => x.path))); // recency sets the default
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools.join(",")]);

  const { active, old } = useMemo(() => ({ active: (all ?? []).filter((c) => c.active), old: (all ?? []).filter((c) => !c.active) }), [all]);

  const toggle = (p: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const addFolder = async () => {
    const p = await window.tm.pickFolder();
    if (!p || all?.some((c) => c.path === p)) return;
    const manual: Candidate = { path: p, name: p.split("/").pop() ?? p, sources: [], lastActive: new Date().toISOString().slice(0, 10), active: true, hasGit: false, markers: [], nested: [], inDownloads: p.includes("/Downloads/"), inICloud: false };
    setAll((a) => [manual, ...(a ?? [])]);
    setChecked((s) => new Set([...s, p]));
  };

  if (!all) return <main className="screen"><p className="muted">קורא את רשימות הפרויקטים של הכלים שבחרת…</p></main>;

  const row = (c: Candidate) => (
    <li key={c.path} className={`project ${checked.has(c.path) ? "on" : ""}`}>
      <label>
        <input type="checkbox" id={`p-${c.path}`} checked={checked.has(c.path)} onChange={() => toggle(c.path)} />
        <span className="project-main">
          <span className="project-name">{c.name}</span>
          <span className="project-path" dir="ltr">{c.path}</span>
        </span>
        <span className="project-meta">
          <span className="when">{relative(c.lastActive)}</span>
          <span className="sources">{c.sources.length ? c.sources.map((s) => SRC[s] ?? s).join(" · ") : "נוסף ידנית"}</span>
        </span>
      </label>
      {(c.nested.length > 0 || c.inDownloads || c.inICloud || !c.hasGit) && (
        <div className="flags">
          {c.nested.length > 0 && <span className="flag">כולל {c.nested.length} תת-תיקיות שנפתחו בנפרד</span>}
          {c.inICloud && <span className="flag warn">ב-iCloud, שעלול לשבור git. כדאי להעביר ל-<bdi dir="ltr">~/Projects</bdi></span>}
          {c.inDownloads && !c.inICloud && <span className="flag">ב-Downloads. כדאי להעביר ל-<bdi dir="ltr">~/Projects</bdi></span>}
          {!c.hasGit && <span className="flag ok">אין git. נסדר את זה בשבילך</span>}
        </div>
      )}
    </li>
  );

  return (
    <main className="screen">
      <header className="screen-head">
        <span className="eyebrow">שלב 2 מתוך 2</span>
        <h1>הפרויקטים שמצאנו</h1>
        <p className="lead">
          קראנו את רשימת התיקיות ש-{desktopTools.map((t) => SRC[t]).join(" ו-")} שומרים במחשב. נתיבים בלבד, לא תוכן שיחות, ושום דבר לא יוצא מהמחשב.
        </p>
      </header>

      {all.length === 0 && <p className="empty">לא מצאנו פרויקטים דרך הכלים שבחרת. הוסף תיקייה ידנית.</p>}

      <ul className="projects">{active.map(row)}</ul>

      {old.length > 0 && (
        <div className="old">
          <button className="link" onClick={() => setShowOld((v) => !v)}>
            {showOld ? "הסתר" : "הצג"} עוד {old.length} פרויקטים ישנים (מעל 90 יום)
          </button>
          {showOld && <ul className="projects">{old.map(row)}</ul>}
        </div>
      )}

      <button className="ghost add" onClick={addFolder}>+ הוסף תיקייה</button>

      <footer className="actions">
        <button className="ghost" onClick={onBack}>חזרה</button>
        <span className="count">{checked.size} נבחרו</span>
        <button className="primary" disabled={checked.size === 0} onClick={() => onNext(all.filter((c) => checked.has(c.path)))}>
          המשך
        </button>
      </footer>
    </main>
  );
}
