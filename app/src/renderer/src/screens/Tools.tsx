import { useEffect, useState } from "react";
import type { DetectedTool, ToolId } from "../../../engine/types.js";

const LABELS: Record<ToolId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  lovable: "Lovable",
  bolt: "Bolt",
  v0: "v0",
  replit: "Replit",
};

export function Tools({ onBack, onNext }: { onBack: () => void; onNext: (tools: ToolId[]) => void }) {
  const [tools, setTools] = useState<DetectedTool[] | null>(null);
  const [selected, setSelected] = useState<Set<ToolId>>(new Set());

  useEffect(() => {
    window.tm.detectTools().then((t) => {
      setTools(t);
      // the app leads: installed tools with projects are pre-checked, the user confirms
      setSelected(new Set(t.filter((x) => x.installed && x.projectCount > 0).map((x) => x.id)));
    });
  }, []);

  const toggle = (id: ToolId) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  if (!tools) return <main className="screen"><p className="muted">מחפש כלים במחשב…</p></main>;

  const desktop = tools.filter((t) => !t.browserOnly);
  const browser = tools.filter((t) => t.browserOnly);
  const canContinue = [...selected].some((id) => desktop.find((t) => t.id === id)?.installed);

  return (
    <main className="screen">
      <header className="screen-head">
        <span className="eyebrow">שלב 1 מתוך 2</span>
        <h1>איפה אתה בונה?</h1>
        <p className="lead">מצאנו את הכלים שמותקנים במחשב. סמן גם כלים שאתה משתמש בהם בדפדפן.</p>
      </header>

      <section>
        <h2 className="group-title">על המחשב הזה</h2>
        <div className="tool-grid">
          {desktop.map((t) => (
            <label key={t.id} className={`tool ${t.installed ? "" : "absent"} ${selected.has(t.id) ? "on" : ""}`}>
              <input type="checkbox" id={`tool-${t.id}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} disabled={!t.installed} />
              <span className="tool-name">{LABELS[t.id]}</span>
              <span className="tool-meta">
                {t.installed ? (t.projectCount ? `${t.projectCount} פרויקטים` : "מותקן, בלי פרויקטים") : "לא נמצא במחשב הזה"}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2 className="group-title">בדפדפן</h2>
        <div className="tool-grid">
          {browser.map((t) => (
            <label key={t.id} className={`tool browser ${selected.has(t.id) ? "on" : ""}`}>
              <input type="checkbox" id={`tool-${t.id}`} checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
              <span className="tool-name">{LABELS[t.id]}</span>
              <span className="tool-meta">בקרוב: ייבוא דרך GitHub</span>
            </label>
          ))}
        </div>
      </section>

      <footer className="actions">
        <button className="ghost" onClick={onBack}>חזרה</button>
        <button className="primary" disabled={!canContinue} onClick={() => onNext([...selected])}>
          המשך
        </button>
      </footer>
    </main>
  );
}
