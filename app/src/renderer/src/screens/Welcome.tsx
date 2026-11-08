export function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <main className="screen welcome">
      <div className="welcome-mark" aria-hidden="true">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
      <h1>כל הפרויקטים שלך, מגובים מחוץ למחשב.</h1>
      <p className="lead">ו-Claude ו-Cursor זוכרים איפה עצרת.</p>
      <ul className="pillars">
        <li>
          <strong>חוצה כלים</strong>
          <span>פרויקט אחד, ציר זמן אחד, לא משנה באיזה כלי נגעת בו.</span>
        </li>
        <li>
          <strong>מחוץ למחשב</strong>
          <span>נקודות שמירה ב-GitHub הפרטי שלך. גם מחשב שמת לא לוקח אותן.</span>
        </li>
        <li>
          <strong>זיכרון</strong>
          <span>כל צ'אט חדש מתחיל ממה שכבר עשית, לא מאפס.</span>
        </li>
      </ul>
      <button className="primary big" onClick={onNext}>
        התחל
      </button>
      <p className="fine">בלי הרשמה. החשבון הוא GitHub, ושום קוד לא עובר בשרתים שלנו.</p>
    </main>
  );
}
