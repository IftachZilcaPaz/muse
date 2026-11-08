import { useEffect, useState } from "react";
import type { Candidate, CheckpointResult } from "../../../engine/types.js";

type Row = { c: Candidate; slug?: string; result?: CheckpointResult; error?: string };

/** Week 1 stand-in for S5: tracks the chosen folders and takes a first local checkpoint of each. GitHub comes in week 3. */
export function Done({ chosen, onRestart }: { chosen: Candidate[]; onRestart: () => void }) {
  const [rows, setRows] = useState<Row[]>(chosen.map((c) => ({ c })));

  useEffect(() => {
    (async () => {
      const recs = await window.tm.track(chosen.map((c) => c.path));
      setRows(chosen.map((c, i) => ({ c, slug: recs[i].slug })));
      for (let i = 0; i < recs.length; i++) {
        try {
          const result = await window.tm.checkpoint(recs[i].slug);
          setRows((r) => r.map((x, j) => (j === i ? { ...x, result } : x)));
        } catch (e) {
          setRows((r) => r.map((x, j) => (j === i ? { ...x, error: String(e) } : x)));
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ack = async (i: number) => {
    const result = await window.tm.checkpoint(rows[i].slug!, true);
    setRows((r) => r.map((x, j) => (j === i ? { ...x, result } : x)));
  };

  const label = (r: Row) => {
    if (r.error) return <span className="pill red">שגיאה</span>;
    if (!r.result) return <span className="pill">עובד…</span>;
    switch (r.result.status) {
      case "created": return <span className="pill green">נקודת שמירה ראשונה נשמרה</span>;
      case "unchanged": return <span className="pill green">כבר מגובה</span>;
      case "needs-ack": return <span className="pill yellow">נמצאו מפתחות</span>;
      case "blocked": return <span className="pill red">מפתח מסוכן בקוד</span>;
      case "skipped-busy": return <span className="pill yellow">git באמצע פעולה</span>;
    }
  };

  return (
    <main className="screen">
      <header className="screen-head">
        <span className="eyebrow">סידור אוטומטי</span>
        <h1>שומרים נקודת שמירה ראשונה</h1>
        <p className="lead">מקומית בלבד בשלב הזה. החיבור ל-GitHub ולהצפנת ה-.env מגיע בשבוע 3.</p>
      </header>
      <ul className="results">
        {rows.map((r, i) => (
          <li key={r.c.path}>
            <div className="result-head">
              <span className="project-name">{r.c.name}</span>
              {label(r)}
            </div>
            {r.result?.excludedLarge.length ? <p className="fine">הוחרגו קבצים מעל 50MB: {r.result.excludedLarge.join(", ")}</p> : null}
            {r.result && (r.result.status === "needs-ack" || r.result.status === "blocked") && (
              <div className="findings">
                {r.result.findings
                  .filter((f) => f.severity !== "green")
                  .map((f, k) => (
                    <div key={k} className={`finding ${f.severity}`}>
                      <code dir="ltr">{f.where}</code>
                      <span>{f.rule} {f.sample}</span>
                      {f.note && <span className="muted">{f.note}</span>}
                    </div>
                  ))}
                {r.result.status === "needs-ack" && (
                  <button className="ghost" onClick={() => ack(i)}>גבה בכל זאת, אחליף את המפתחות</button>
                )}
                {r.result.status === "blocked" && <p className="fine">מפתח מסוג service_role או מפתח live בקוד. בקש מ-Claude או מ-Cursor להעביר אותו ל-.env ונסה שוב.</p>}
              </div>
            )}
            {r.error && <p className="fine red" dir="ltr">{r.error}</p>}
          </li>
        ))}
      </ul>
      <footer className="actions">
        <button className="ghost" onClick={onRestart}>התחל מחדש</button>
      </footer>
    </main>
  );
}
