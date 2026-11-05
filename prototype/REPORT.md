# דוח ניסוי: אב-טיפוס של מנוע הגיבוי

תאריך: 5.11.2026. גרסת אפיון שנבדקה: 0.4 (מודל נקודות השמירה, כלל "דוחפים רק לריפו שיצרנו", שחזור ברמת קבצים, דילול בשכתוב).

## מה יש כאן

| קובץ | תפקיד |
| --- | --- |
| `tm.py` | המנוע. קובץ Python אחד, כל פעולת git בו ממופה לקריאה ב-libgit2 (ראו טבלה בסוף). |
| `make_samples.sh` | מייצר שתי תיקיות מבולגנות וגם "תיקיית בית" מזויפת עם `.claude.json` ו-`workspaceStorage` של Cursor. כל ה"סודות" מחרוזות מזויפות. |
| `run_demo.sh` | מריץ את כל התרחיש מקצה לקצה עם 32 בדיקות אוטומטיות. |

הרצה:

```bash
./prototype/run_demo.sh /tmp/tm-demo
```

עם URL של ריפו גיבוי כפרמטר שני, הסקריפט גם דוחף את ה-refs הנסתרים לשם.

## שתי הדוגמאות

**noa-landing.** אפליקציית Vite עם React בתיקיית Downloads, בלי git בכלל. מפתח Supabase מסוג anon בקוד, מפתח Stripe מסוג `sk_test` בקוד, קובצי `.env` ו-`.env.local`, תיקיית `node_modules`, תיקיית `dist`, קובץ `.DS_Store`, וקובץ וידאו של 55MB.

**recipes-bot.** בוט Python עם git קיים ומבולגן: `.env` עם מפתח service_role נכנס ל-commit הראשון והוסר בשני, מפתח service_role גם בקוד עצמו, שינויים לא שמורים, `dev.db`, `.venv`.

## מה עבד (32 מתוך 32)

**גילוי.** קריאת `~/.claude.json` ו-`workspace.json` של Cursor, סינון תיקיית הבית, תיקיות נקודה ו-`Library`, קיפול תיקייה מקוננת לתוך האב, פענוח קידוד URL של Cursor, ומיון לפי פעילות אחרונה עם סף של 90 יום.

**מדיניות סודות.** anon ו-`pk_` ירוקים. `sk_test` צהוב וחוסם עד אישור מפורש. service_role בקוד אדום וחוסם גם עם אישור. אחרי שהמשתמש "מתקן" את הקוד, ממצא שנשאר רק בהיסטוריה הוא צהוב.

**נקודת שמירה.** עץ נבנה מ-index זמני, בלי לגעת ב-HEAD, ב-index או ב-branch של המשתמש. הקובץ של 55MB הוחרג עם הודעה. `node_modules`, `dist`, `.DS_Store`, `dev.db` לא נכנסו. `.env` לא נשמר גלוי אלא כ-`.timemachine/secrets.age` מוצפן לשני מפתחות. ההודעה נוצרת מ-diff stat בלי מודל. "אין שינויים" מזוהה ולא יוצר נקודה. ריפו באמצע rebase מדולג.

**הורים.** בנקודה הראשונה ה-commit האחרון של המשתמש הוא ההורה. בנקודות הבאות הוא מתווסף כהורה שני רק כשה-HEAD זז.

**שחזור.** תרחיש "סוכן מחק קובץ ודרס קובץ": השחזור כתב את הקבצים בחזרה, פענח את ה-.env, אימת שהעץ בתיקייה שווה לעץ של הנקודה, ורשם נקודה חדשה "שוחזר ל-X". HEAD נשאר unborn, כלומר בלי checkout.

**דילול.** על 38 נקודות עם תאריכים מזויפים: מדיניות Pro השאירה 29 (הכול ל-24 שעות, שעתי לשבוע, יומי לחודש, שבועי מעבר). מדיניות Free השאירה 24. העץ של הנקודה האחרונה לא השתנה, הקישורים ל-commits של המשתמש שרדו, המזהים היציבים מופו ל-SHA החדשים, ו-main של המשתמש לא נגע.

**מחשב חדש.** ריפו ריק, fetch של ה-ref הנסתר בלבד, פענוח `secrets.age` עם מפתח השחזור לבדו, ושחזור מלא של התיקייה.

## מה לא נבדק

1. **GitHub עצמו.** שער ה-git של סשן הענן מתיר push רק ל-branch שהוקצה לסשן. push ל-`refs/timemachine/*` וגם push של tag נדחו ב-403 אחרי שהרשאת הכתיבה לריפו סודרה. לכן לא אומת מכאן שה-ref לא מופיע כ-branch, שקישור ל-commit נפתח, ושה-ref מופיע ב-`ls-remote`. זה נבדק ממחשב רגיל עם git מחובר ל-GitHub:

   ```bash
   git clone -b claude/zen-clarke-r58m65 https://github.com/IftachZilcaPaz/vibe && cd vibe
   ./prototype/run_demo.sh /tmp/tm-demo https://github.com/IftachZilcaPaz/vibe
   ```

   ואז ב-GitHub: רשימת ה-branches לא אמורה להשתנות, `git ls-remote` אמור להציג שני refs תחת `refs/timemachine/`, וכתובת `https://github.com/IftachZilcaPaz/vibe/commit/<sha>` של נקודת שמירה אמורה להיפתח. אם הריפו מחובר ל-Vercel או ל-Netlify, זו גם בדיקת ה-deploy.
2. **Vercel ו-Netlify.** דורש ריפו מחובר לחשבון של המשתמש.
3. **מרוץ עם סוכן בזמן שחזור.** הלולאה החסומה קיימת בקוד, אבל לא הופעלה בבדיקה, כי אין Watcher באב-הטיפוס.
4. **Watcher ו-debounce.** לא מומשו. האב-טיפוס מופעל ידנית.

## ממצאים שמשנים את האפיון

1. **ממצא בהיסטוריה הוא תמיד צהוב, גם service_role.** בהרצה הראשונה recipes-bot נתקע לנצח: הכלל "אדום חסום עד תיקון" פגש סוד שיושב בהיסטוריה, ואת זה המשתמש לא יכול לתקן בעריכת קובץ. התרופה היחידה היא החלפת המפתח, ולכן האישור בצהוב מנוסח "החלפתי את המפתח". אדום נשאר רק לקוד שאנחנו עומדים לשמור עכשיו.
2. **ההיסטוריה של המשתמש נדחפת איתנו.** כיוון שה-commit של המשתמש הוא הורה של הנקודה, push של השרשרת מביא את כל ההיסטוריה שלו לריפו הגיבוי. זו הסיבה שסריקת ההיסטוריה חובה גם בלי מראה של branches. צריך לכתוב את זה במפורש בסעיף הסודות.
3. **`.gitignore` נכתב רק כשאין אחד.** בלי זה, Cursor מציג ל-noa-landing את `.DS_Store` ואת `.env` כקבצים לא עוקבים. לריפו קיים עם `.gitignore` משלו לא נוגעים, וההחרגות שלנו חלות דרך excludes חיצוני.
4. **HEAD נשאר unborn בפרויקט שלא היה בו git.** זה נאמן לכלל "לא נוגעים ב-branch של המשתמש", אבל Cursor יציג "no commits yet". שאלת מוצר: האם לייצר commit ראשון אחד על main בריפו שאנחנו יצרנו מאפס. ההמלצה: כן, פעם אחת, רק כשאנחנו אלה שהרצנו git init, כי אז ה-branch הוא שלנו.
5. **הנקודה הראשונה מקושרת ל-HEAD כהורה יחיד.** זה אומר ש-`git log --first-parent` על ה-ref שלנו ממשיך לתוך ההיסטוריה של המשתמש. המנוע עוצר על ה-trailer `TM-Id`. המימוש ב-Rust צריך לשמור את הכלל הזה, אחרת הדילול ישכתב commits של המשתמש. זה בדיוק הבאג שנמצא ותוקן כאן.
6. **זמן פעילות לפי תיקייה הוא אות חלש.** תאריך השינוי של תיקיית השורש משתנה רק כשנוסף או נמחק קובץ ישירות בה. המקור הטוב הוא תאריכי קובצי השיחה של Claude Code ותיקיית ה-workspace של Cursor. המנוע לוקח את המאוחר מבין השלושה.
7. **סריקת היסטוריה רצה רק כשה-HEAD זז.** אחרת כל נקודה הייתה סורקת את כל האובייקטים מחדש. ב-Rust כדאי גם לשמור מטמון לפי SHA של blob.

## מיפוי ל-libgit2 בשביל המפתח

| בסקריפט | ב-libgit2 (git2-rs) |
| --- | --- |
| `GIT_INDEX_FILE=tmp git add -A` עם `core.excludesFile` | `Index::new()` + `add_all` עם callback שמסנן לפי `Repository::is_path_ignored` ורשימת ההחרגות שלנו |
| `git hash-object -w` + `update-index --cacheinfo` | `Odb::write` + `Index::add_frombuffer` |
| `git write-tree` | `Index::write_tree_to(&repo)` |
| `git commit-tree -p a -p b` | `Repository::commit(None, …, &[parent_a, parent_b])` עם `None` כדי לא להזיז שום ref |
| `git update-ref ref new old` | `Reference::set_target` אחרי השוואה ל-old, או `reference_matching` |
| `git push +refs/timemachine/x:refs/timemachine/x` | `Remote::push(&["+refs/timemachine/x:refs/timemachine/x"])` |
| `git log --first-parent` עם trailers | `Revwalk` עם `simplify_first_parent` וקריאת ה-trailers מה-message |
| `git rev-parse --git-path rebase-merge` | `Repository::state()` מחזיר `RepositoryState::Rebase*` וכו' |
| `git ls-tree -r` + `cat-file blob` | `Tree::walk` + `Blob::content` |
| `age -r … -r …` | crate `age` עם שני `x25519::Recipient` |

מה שאין ב-libgit2 ויש כאן: `gc`. האב-טיפוס לא צריך אותו, האפליקציה תצטרך repack תקופתי.
