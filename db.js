const fs = require("fs");
const path = require("path");

// DATA_DIR lets the DB file live outside the app's own folder - critical on hosts like
// Render, where the app folder itself is wiped and rebuilt from git on every deploy. Point
// DATA_DIR at a mounted persistent disk in production; without it, this falls back to a
// "data" folder next to the app files, which is fine for local development only.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

function defaultData() {
  return {
    settings: {
      siteName: "SheCan",
      tagline: "קהילה עוצמתית לנשים ועצמאיות",
      weeklyMessage: "היי לך, השבוע כדאי שתעיפי מבט על העצמאיות החדשות שהצטרפו אלינו - יש שם כמה הטבות ששוות בדיקה.",
      // עצמאית השבוע - בחירה ידנית של האדמין. תופסת רק למחזור אחד (עד יום ראשון 08:00 הבא) ואז
      // מתאפסת אוטומטית - ר' tickRotation ב-server.js.
      freelancerOfWeekId: null,
      // מצביע התור האוטומטי (מי בתור/מוצגת כרגע) + חותמת הזמן של המחזור האחרון שטופל - שני
      // אלה יחד הם מה שנותן לתור להמשיך "מאיפה שהוא עצר" גם כשהיתה בחירה ידנית באמצע.
      weeklyTipCurrentFreelancerId: null,
      weeklyTipLastBoundary: null,
      // מקבילה לתור סיפורי ההשראה - בחירה ידנית (מחזור אחד, עד יום רביעי 20:00 הבא) + מצביע
      // התור האוטומטי.
      storyOfWeekId: null,
      currentStoryId: null,
      storyLastBoundary: null,
      chargingEnabled: false, // תקופת השקה חינמית
      // תחרות "הביאי חברה" ללקוחות - קישור אישי (?ref=<customerId>) שכל לקוחה מקבלת. עריכים
      // כאן כברירת מחדל בלבד - כל הערכים האלה ניתנים לעריכה בפאנל הניהול בלי דיפלוי, כדי
      // שיהיה אפשר לכבות את התחרות או לעדכן תאריכים כשהיא מסתיימת.
      customerReferralContestActive: true,
      customerReferralContestEndDate: "15.9",
      customerReferralAnnounceDate: "16.9",
      // מקבילה לעצמאיות - קישור אישי (?ref=<freelancerId>) ל-/join. הפניה מוצלחת מזכה בנקודה
      // לקראת תואר "העסק המוביל" של החודש.
      freelancerReferralContestActive: true,
      freelancerReferralContestEndDate: "17.9",
      freelancerReferralAnnounceDate: "20.9",
      searchEngineVisible: false, // כל עוד false - האתר חסום למנועי חיפוש (Google וכו')
      communityWhatsappLink: "", // קישור הצטרפות לקבוצת הוואטסאפ - להשלים בפאנל הניהול
      contactEmail: "", // מייל ליצירת קשר - להשלים בפאנל הניהול
      adPrice: null, // מחיר ייחוס למודעה בצד העמוד (₪ לחודש) - להשלים בפאנל הניהול
      pricing: { basic: 49, premium: 109 },
      siteLogoDataUri: null, // לוגו מותאם אישית (מוחלף על הוורדמארק "SheCan") - להעלאה בפאנל הניהול
      topBannerDataUri: null, // באנר קבוע בראש כל עמוד, מעל הסרגל - להעלאה בפאנל הניהול
      siteBackgroundImageDataUri: null, // תמונת רקע לכל האתר, מתחת לסרגל העליון - להעלאה בפאנל הניהול
      // תקנון ומדיניות פרטיות - טקסט חופשי שנערך בפאנל הניהול (לא בקוד), ומוצג ב-/terms
      // וב-/privacy בהתאמה. שורה ריקה = פסקה חדשה, "## " בתחילת שורה = כותרת משנה,
      // **טקסט** = טקסט מודגש - ר' renderRichText בשרת.
      termsText: "תקנון ומדיניות פרטיות - טקסט לדוגמה בינתיים, כדאי להשלים עם ייעוץ משפטי לפני שעולים לאוויר.",
      aboutText: "SheCan נולד מתוך קהילה אמיתית של נשים עצמאיות שרצו לדחוף אחת את השנייה קדימה. את יכולה לעדכן את הטקסט הזה בהמשך ולספר את הסיפור שלך.",
      ourStoryText: `SheCan נולד מתוך רצון פשוט: לתת לכל עצמאית בישראל מקום אחד שבו אפשר להיראות, להתגאות במה שהיא בנתה, ולהתחבר ללקוחות שבאמת מחפשות אותה.

הבנו שיש כאן כוח אדיר - אלפי נשים שבונות עסק לבד, מתחילות מאפס, ומגיעות רחוק. רצינו לתת לכוח הזה בית: קהילה שבה עצמאיות תומכות אחת בשנייה, ולקוחות מוצאות בקלות את מי שהן מחפשות.

ככה נולד SheCan - קהילה עוצמתית לנשים ועצמאיות, שבה כל אחת יכולה להציג את העסק שלה, לתת הטבה שמושכת לקוחות חדשות, ולקבל המלצות חמות שבונות אמון.

אנחנו רק בהתחלה, וזו רק תחילת הדרך - מוזמנת להיות חלק מהסיפור. ❤️`,
      privacyPolicyText: `מדיניות פרטיות זו חלה על המידע והנתונים שתמסרי ל-SheCan (להלן: "האתר" או "אנחנו"), לרבות במסגרת תהליך ההרשמה לאתר - כעצמאית וכלקוחה כאחד - על התכנים והמידע המועברים על ידי המשתמשות בזמן השימוש באתר ובשירותים המוצעים בו, וכן על מידע שנאסף על אודות המשתמשות בזמן הגלישה באתר (להלן יחד "מידע על המשתמשת" או "המידע האישי").

בשימושך באתר הנך נותנת הסכמתך לתנאי מדיניות פרטיות זו, ובכלל זה לכל איסוף, עיבוד ושיתוף של המידע האישי למטרות האמורות בה. אם אינך מסכימה למדיניות פרטיות זו, אנא אל תיכנסי ואל תעשי שימוש באתר ובשירותיו.

"מידע אישי" פירושו כל מידע היכול לשמש, בין אם לבדו ובין אם בשילוב עם מידע אחר, לזהות אדם באופן אישי - לרבות ומבלי לגרוע מכלליות האמור, שם מלא, כתובת דואר אלקטרוני, מספר טלפון, תמונות, פרטי עסק ופרטי קשר אחרים.

הנתונים שתמסרי בעת ההרשמה לשירותים באתר ו/או בעת עדכון פרטייך (כפי שייעשה מעת לעת), יישמרו במאגר המידע של האתר, המנוהל בהתאם לחוק הגנת הפרטיות, התשמ"א – 1981. אינך מחויבת על-פי חוק למסור את המידע - מסירתו נעשית בהסכמתך המלאה והחופשית - אולם אם לא תמסרי מידע נדרש, ייתכן שלא תוכלי להשתמש בשירותים מסוימים באתר.

הרישום לשירותים הוא מגיל 18 ומעלה. אם גילך נמוך מ-18, אנא הימנעי ממסירת פרטים אישיים ומהרשמה לאתר.

## המידע שנאסף ואופן איסופו

1. **הרשמה כעצמאית.** בעת פתיחת פרופיל עסקי, תידרשי למסור מידע כמו שם מלא, שם העסק, כתובת דואר אלקטרוני, סיסמה, מספר טלפון, תחום עיסוק וקטגוריה, עיר, קישור לאינסטגרם/תיק עבודות (אם יש), תיאור העסק ופרטי ההטבה שאת מציעה, וכן תמונות שתבחרי להעלות.
2. **הרשמה כלקוחה.** לצורך שמירת מועדפים, כתיבת המלצות ושליחת הודעות לעצמאיות, תידרשי למסור שם מלא, כתובת דואר אלקטרוני וסיסמה.
3. **תוכן שאת בוחרת לשתף.** לרבות המלצות/ביקורות שאת כותבת על עצמאית, הודעות שאת שולחת או מקבלת דרך מערכת ההודעות באתר, וסיפור אישי שאת בוחרת לשלוח לפרסום בעמוד "SheCan Stories".
4. **"צרי קשר".** בעת פנייתך אלינו, ייתכן שתידרשי לספק מידע כגון שמך וכתובת המייל שלך.
5. **שימוש בהטבות ומועדפים.** האתר עוקב אחרי חשיפת קודי קופון, ושומר אילו עסקים סימנת כמועדפים.
6. **איסוף עצמאי בסיסי.** לצורך תפעול השירות בלבד - כגון מועד ההתחברות האחרון ופרטים טכניים בסיסיים (כתובת IP, סוג דפדפן). נכון לכתיבת מדיניות זו, האתר אינו משתמש בכלי ניתוח/מעקב חיצוניים כמו Google Analytics, ואינו מציע התחברות דרך פייסבוק/גוגל.
7. **קבצי Cookie.** בהתאם למפורט במדיניות פרטיות זו להלן.

## השימוש במידע

1. לצורך אספקת השירותים - הצגת הפרופיל העסקי שלך, חשיפת קודי הטבה, שמירת מועדפים, פרסום המלצות והעברת הודעות - וכן שיפור האתר.
2. לצורך ניתוח פנימי בלבד, **מבלי למכור או להעביר מידע אישי מזהה לגורמי פרסום חיצוניים.**
3. לזהות ולאמת את הגישה שלך לשירותים אליהם את מורשית לגשת.
4. ליצירת קשר עמך במייל בנוגע לשירות עצמו בלבד - אישור הרשמה, איפוס סיסמה, התראה על הודעה או המלצה חדשה, אישור פרסום סיפור, או מענה לפנייתך. **האתר אינו שולח כיום דיוור שיווקי או פרסומות מטעם עסקים אחרים.**
5. לשם אספקת תכנים המותאמים לך - למשל הצגת עסקים בקטגוריה ובעיר הרלוונטיות לך.

## שיתוף המידע עם צדדים שלישיים

האתר אינו מוכר ואינו משתף מידע אישי מזהה עם מפרסמים חיצוניים. עם זאת, ייתכן שיתוף מידע במקרים הבאים:

- ספקי תשתית טכנולוגיים המסייעים בתפעול האתר - לרבות שירותי אחסון ושירות לשליחת מיילים אוטומטיים. מידע כאמור עשוי לעבור עיבוד גם מחוץ לישראל, כחלק מהתפעול הרגיל של שירותים אלו.
- אם יימצא כי פעולותייך באתר מפרות את תנאי השימוש, או נעשות לשם ביצוע תרמית.
- אם נהיה מחויבים לעשות כן על פי דין, הליך משפטי, צו שיפוטי או בקשה של רשות מוסמכת.
- לשם הגנה מפני פגיעה בזכויות, ברכוש או בבטיחות שלנו, של משתמשות אחרות, שלך או של הציבור.

## המלצות וחוות דעת שאת כותבת

המלצה שאת כותבת על עסק מתפרסמת באופן מיידי. יש לך אפשרות לסמן שאת מעדיפה להישאר אנונימית - במקרה כזה יוצג "חברת קהילה שמעדיפה להישאר אנונימית 😊" במקום שמך. גם בלי לסמן אנונימיות, מוצג באתר רק שמך הפרטי המלא ואות ראשונה משם המשפחה, לא שמך המלא. ניתן לבקש בכל שלב את מחיקת המידע האישי שלך - חוות דעת שכתבת ימשיכו להתפרסם, אך יוצגו באופן אנונימי לחלוטין.

## קישורים לאתרים של צדדים שלישיים

מסירת פרטים באתרים חיצוניים שאליהם מגיעים דרך קישורים באתר (תיק עבודות, אינסטגרם, וואטסאפ) כפופה למדיניות הפרטיות של אותם אתרים, ואיננו נושאים באחריות לשימוש שהם עושים במידע.

## אבטחת מידע

האתר פועל לפי סטנדרטים סבירים ומקובלים כדי להגן על המידע האישי שלך, לרבות שמירת סיסמאות בהצפנה חד-כיוונית והתאמה לדרישות תקנות הגנת הפרטיות (אבטחת מידע), התשע"ז - 2017. עם זאת, איננו יכולים להתחייב ל-100% אבטחת מידע.

## קבצי Cookie

האתר משתמש בקובץ Cookie אחד בלבד - קובץ התחברות (session) שמזהה אותך כמחוברת לחשבון שלך בזמן הגלישה. קובץ זה אינו משמש למעקב פרסומי או לאיסוף מידע לצדדים שלישיים. אם תבחרי לחסום Cookies בדפדפן שלך, ייתכן שלא תוכלי להתחבר לחשבון באתר.

## הזכות לעיין במידע, לתקן ולמחוק

בהתאם לחוק הגנת הפרטיות, כל אדם זכאית לעיין בעצמה, או על ידי בא-כוח שהרשתה לכך בכתב, או על ידי אפוטרופוס, במידע עליה המוחזק במאגר המידע של האתר. מי שעיינה במידע עליה ומצאה שאינו נכון, שלם, ברור או מעודכן, רשאית לפנות בבקשה לתקן את המידע או למחוק אותו.

שימי לב: מחיקת מידע עלולה למנוע ממך להמשיך ולהשתמש בשירות, ותביא לביטול הרישום שלך לשירות. מידע הדרוש לנו על-פי דין ימשיך להישמר, אך לא ישמש עוד לצורך פניה אלייך. חוות דעת שכתבת ימשיכו להתפרסם, אך באופן אנונימי לחלוטין.

לצורך עיון במידע או בקשה למחיקתו, אפשר לפנות אלינו במייל: **shecan.office@gmail.com**. אם בתוך 30 יום לא תקבלי הודעה שהמידע שביקשת למחוק אכן נמחק, תהיי זכאית לפנות לבית המשפט באופן הקבוע בתקנות מכוח חוק הגנת הפרטיות.

## מיזוג, מכירה או שינוי מבנה

במידה והאתר יימכר, יעבור מיזוג עם צד שלישי, או יעבור לבעלות אחרת, אנו שומרים לעצמנו את הזכות להעביר לצד שלישי כאמור מידע אישי שנמסר על ידך ו/או שנאסף על ידינו בהתאם למדיניות פרטיות זו.

## שינויים במדיניות זו

אנו רשאים לשנות מדיניות פרטיות זו מעת לעת. שינוי כאמור ייכנס לתוקפו תוך 7 ימים לאחר פרסום המדיניות המעודכנת באתר. המשך השימוש שלך בשירותים לאחר שינוי כזה פירושו הסכמה לשינויים אלה.

## יצירת קשר

אם את סבורה שפרטיותך נפגעה במהלך השימוש באתר, וכן בכל שאלה בנושא מדיניות הפרטיות - אנא צרי קשר במייל: **shecan.office@gmail.com**.`,
      // הצהרת נגישות - טקסט חופשי שנערך בפאנל הניהול, מוצג ב-/accessibility ומקושר מהפוטר
      // בכל עמוד. חובה על פי חוק שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות), התשס"ה - 2005,
      // ותקנות הנגישות מכוחו (תקן 5568, המבוסס על WCAG 2.1 רמה AA) - חלה כמעט על כל אתר,
      // ללא קשר לגודל העסק. חייבת לכלול 3 חלקים: (1) פעולות נגישות שננקטו באתר, (2) הצהרה
      // לגבי נגישות פיזית (או שאין מקום פיזי), (3) פרטי רכזת הנגישות.
      accessibilityStatementText: `אתר SheCan פועל במידת האפשר להנגשת האתר לאנשים עם מוגבלות, מתוך אמונה כי לכל אדם מגיעה הזכות לגלוש ולהשתמש באתר בכבוד, בשוויון, בנוחות ובעצמאות.

## פעולות הנגישות שננקטו באתר

אנו פועלות בהתאם לתקן הישראלי (ת"י) 5568 להנגשת תכנים באינטרנט, המבוסס על הנחיות WCAG 2.1 ברמה AA, ובכלל זה:

- אפשרות דילוג ישירות לתוכן המרכזי של העמוד, לפני תפריט הניווט, עבור משתמשות במקלדת ובקוראי מסך.
- מבנה תגיות סמנטי (כותרות, אזורי ניווט, טפסים) המאפשר ניווט תקין עם קוראי מסך.
- קישור ברור ועקבי בין תוויות (labels) לשדות הטופס המתאימים להן.
- אינדיקציה חזותית ברורה (מסגרת מודגשת) סביב האלמנט שבפוקוס, עבור ניווט במקלדת.
- טקסט חלופי (alt) לתמונות משמעותיות באתר.
- ערכת נגישות זמינה בכל עמוד (הכפתור המסומן ♿ בפינת המסך), המאפשרת: הגדלה/הקטנה של גודל הטקסט, מעבר לתצוגת ניגודיות גבוהה, הדגשת קישורים באמצעות קו תחתון, ועצירת אנימציות באתר.

אנו ממשיכות לעבוד על שיפור הנגישות באתר באופן שוטף.

## נגישות פיזית

SheCan הוא אתר אינטרנט בלבד, ואין לנו סניף, משרד או מקום עסק פיזי הפתוח לקהל. לכן אין רלוונטיות להנגשה פיזית של מקום כאמור.

## פניות, הצעות ותקלות נגישות

אם נתקלת בבעיה או בקושי בנגישות האתר, או שיש לך הצעה לשיפור - נשמח שתפני אלינו ונטפל בפנייתך בהקדם האפשרי.

**רכזת הנגישות:** ספיר
**דוא"ל:** shecan.office@gmail.com

הצהרת נגישות זו עודכנה לאחרונה ביולי 2026.`,
      // השאלות הקבועות שכל עצמאית עונה עליהן כדי ליצור את "הסיפור שלה" - ניתנות לעריכה
      // בפאנל הניהול (הוספה/מחיקה). התשובות שלה לשאלות האלו הן תוכן הסיפור עצמו.
      storyQuestions: [
        "איך הכל התחיל? מהו השלב שבו הבנת שאת יוצאת לדרך עצמאית?",
        "מה הלב של העסק שלך? (במשפט אחד או שניים – מה את עושה ומי הלקוחה שאת הכי אוהבת לעזור לה?)",
        "מה האתגר הראשון או הגדול שהצלחת לפצח בדרך? (משהו שדרש ממך אומץ או לימד אותך שיעור חשוב).",
        "מה הדבר שאת הכי אוהבת לראות קורה אצל הלקוחות שלך בסוף התהליך?",
        "איפה את רואה את העסק שלך בשנים הקרובות? (חלום קטן או גדול שבא לך להגשים).",
      ],
    },
    contactMessages: [], // הודעות שהושארו בעמוד "צרי קשר"
    couponRevealEvents: [], // לוג גלובלי של כל לחיצה על "לצפייה בקוד קופון" - freelancerId + date
    chatMessages: [], // התכתבויות ישירות בין לקוחות לעצמאיות - { id, freelancerId, customerId, fromRole, text, date, read }
    // עמוד "הזירה" - חלק 1: "אתן שואלות, המומחיות עונות". לקוחה שואלת שאלה בתחום/תת-תחום
    // נבחר, השאלה עוברת אישור אדמין, ולאחר אישור נשלח מייל לכל העצמאיות המאושרות באותו
    // תחום עם קישור ישיר לענות. { id, customerId, customerName, categoryId, subcategoryId,
    // questionText, status: pending|approved|rejected, createdAt,
    // answers: [{ id, freelancerId, freelancerName, text, createdAt }] }
    arenaQuestions: [],
    // עמוד "הזירה" - חלק 2: "פינת ההתייעצויות". לקוחה מבקשת התייעצות, עוברת אישור אדמין,
    // ולאחר אישור עולה לעמוד וכל לקוחה או עצמאית רשומה יכולה להגיב עם עצה. { id, customerId,
    // customerName, text, status: pending|approved|rejected, createdAt,
    // replies: [{ id, authorRole: "freelancer"|"customer", authorId, authorName, text, createdAt }] }
    consultations: [],
    // עמוד "הזירה" - חלק 3: "מה דעתך?". עצמאית יוצרת סקר (מוגבלת לסקר אחד בשבוע), ולקוחות
    // (או כל מי שנכנס דרך קישור השיתוף, גם בלי התחברות) מסמנות תשובה. { id, freelancerId,
    // freelancerName, question, options: [{ text, votes }], voters: [], createdAt }
    // voters מכיל "customer:<id>" עבור לקוחות מחוברות, או "anon:<token>" עבור מצביעות
    // אנונימיות שהגיעו דרך קישור השיתוף - כדי למנוע הצבעה כפולה מאותו דפדפן.
    polls: [],
    // Each main category can have subcategories, so an area like "יופי וטיפוח" can be
    // broken down into "מאפרת כלות וערב", "מניקוריסטית ולק ג'ל" וכו'. A freelancer picks
    // a main category (required) and, if that category has subcategories, an optional
    // more specific one - so search/browse stays simple (by main category) while the
    // profile itself can show the precise specialty.
    categories: [
      ["יופי וטיפוח", ["מאפרת כלות וערב", "מניקוריסטית ולק ג'ל", "קוסמטיקאית וטיפולי פנים", "מעצבת שיער", "עיצוב גבות וריסים", "איפור קבוע"]],
      ["בריאות ורפואה משלימה", ["רפלקסולוגיה", "שיאצו ועיסוי", "נטורופתיה", "הומאופתיה", "דיקור סיני", "ריפוי בעיסוק"]],
      ["אימון גופני ובריאות", ["אימון כושר אישי", "יוגה ופילאטיס", "ריצה והליכה", "תזונת ספורט", "אימון קבוצתי"]],
      ["ליווי נפשי ואימון אישי (קואצ'ינג)", ["אימון עסקי", "אימון אישי לחיים", "אימון זוגי", "NLP", "ליווי רוחני"]],
      ["הריון, לידה והורות", ["דולה", "ייעוץ הנקה", "הכנה ללידה", "ליווי הורות", "טיפול תינוקות"]],
      ["חינוך, הוראה והעשרה", ["שיעורים פרטיים", "חוגי העשרה לילדים", "הכנה לבגרויות", "לימוד שפות", "הכשרות מקצועיות"]],
      ["טיפול בילדים ומשפחה", ["בייביסיטר", "גנן/ת פרטית", "ריפוי בעיסוק לילדים", "ייעוץ הורי", "טיפול רגשי לילדים"]],
      ["עיצוב ואמנות", ["עיצוב גרפי", "עיצוב פנים", "ציור ואמנות", "קרמיקה", "קליגרפיה"]],
      ["צילום ווידאו", ["צילום אירועים", "צילום מוצרים", "עריכת וידאו", "צילום ניובורן", "צילום דרון"]],
      ["אופנה, סטייליניג ותפירה", ["סטייליסטית אישית", "תופרת ותיקונים", "עיצוב תכשיטים", "עיצוב אופנה", "ייעוץ ארונות"]],
      ["שיווק דיגיטלי ורשתות חברתיות", ["ניהול רשתות חברתיות", "קופירייטינג", "פרסום ממומן", "בניית אתרים", "צילום תוכן"]],
      ["ייעוץ עסקי וניהול", ["ייעוץ אסטרטגי", "ליווי סטארטאפים", "ניהול פרויקטים", "ייעוץ שיווקי"]],
      ["משפטים, ראיית חשבון וייעוץ פיננסי", ["עורכת דין", "ייעוץ מס", "הנהלת חשבונות", "ייעוץ פיננסי אישי"]],
      ["טכנולוגיה ופיתוח", ["פיתוח אתרים", "פיתוח אפליקציות", "עיצוב UX/UI", "ייעוץ טכנולוגי"]],
      ["אירועים ושמחות", ["תכנון אירועים", "עיצוב אירועים", "הפקת חתונות", "DJ והגברה", "קייטרינג לאירועים"]],
      ["מזון, אפייה ותזונה", ["אפיית עוגות מעוצבות", "שף פרטי", "ייעוץ תזונה", "קייטרינג ביתי"]],
      ["בית, גינון וארגון הבית", ["ארגון ועיצוב הבית", "גינון ונוף", "ניקיון מקצועי", "פנג שואי"]],
      ["תרגום, כתיבה ועריכה", ["תרגום מסמכים", "עריכה לשונית", "כתיבה שיווקית", "כתיבת תוכן"]],
    ].map(([name, subs], i) => ({
      id: String(i + 1), name,
      subcategories: subs.map((sname, j) => ({ id: `${i + 1}-${j + 1}`, name: sname })),
    })),
    cities: [
      "תל אביב", "ירושלים", "חיפה", "ראשון לציון", "פתח תקווה", "אשדוד",
      "נתניה", "באר שבע", "חולון", "רמת גן", "בת ים", "רחובות", "אשקלון",
      "הרצליה", "כפר סבא", "רעננה", "מודיעין", "נס ציונה", "קריית אונו",
      "הוד השרון", "עפולה", "נהריה", "אילת", "טבריה", "כרמיאל",
    ].map((name, i) => ({ id: String(i + 1), name })),
    freelancers: [],
    customers: [],
    reviews: [],
    magazines: [],
    stories: [], // "סיפור השראה שבועי" - ראיון/פוסט שספיר מעלה ידנית על עצמאית אחת - { id, title, freelancerId, content, photoDataUri, createdAt }
    admins: [
      { id: "1", email: "admin@shecan.co.il", name: "ספיר", passwordHash: null, pushSubscriptions: [] },
    ],
    nextId: { freelancer: 1, customer: 1, review: 1, magazine: 1, coupon: 110, message: 1, chat: 1, story: 1, storyComment: 1, listing: 1, arenaQuestion: 1, arenaAnswer: 1, consultation: 1, consultationReply: 1, poll: 1 },
  };
}

// Fills in any fields that were added after a site was already deployed/used,
// so an older data/db.json file on Render doesn't crash on missing keys.
function migrate(data) {
  const def = defaultData();
  let changed = false;
  for (const key of Object.keys(def.settings)) {
    if (!(key in data.settings)) { data.settings[key] = def.settings[key]; changed = true; }
  }
  if (!Array.isArray(data.magazines)) { data.magazines = []; changed = true; }
  if (!Array.isArray(data.contactMessages)) { data.contactMessages = []; changed = true; }
  if (!Array.isArray(data.couponRevealEvents)) { data.couponRevealEvents = []; changed = true; }
  if (!Array.isArray(data.chatMessages)) { data.chatMessages = []; changed = true; }
  if (!Array.isArray(data.stories)) { data.stories = []; changed = true; }
  if (!Array.isArray(data.arenaQuestions)) { data.arenaQuestions = []; changed = true; }
  if (!Array.isArray(data.consultations)) { data.consultations = []; changed = true; }
  if (!Array.isArray(data.polls)) { data.polls = []; changed = true; }
  if (!("magazine" in data.nextId)) { data.nextId.magazine = 1; changed = true; }
  if (!("coupon" in data.nextId)) { data.nextId.coupon = 110; changed = true; }
  if (!("message" in data.nextId)) { data.nextId.message = 1; changed = true; }
  if (!("chat" in data.nextId)) { data.nextId.chat = 1; changed = true; }
  if (!("story" in data.nextId)) { data.nextId.story = 1; changed = true; }
  if (!("storyComment" in data.nextId)) { data.nextId.storyComment = 1; changed = true; }
  if (!("listing" in data.nextId)) { data.nextId.listing = 1; changed = true; }
  if (!("arenaQuestion" in data.nextId)) { data.nextId.arenaQuestion = 1; changed = true; }
  if (!("arenaAnswer" in data.nextId)) { data.nextId.arenaAnswer = 1; changed = true; }
  if (!("consultation" in data.nextId)) { data.nextId.consultation = 1; changed = true; }
  if (!("consultationReply" in data.nextId)) { data.nextId.consultationReply = 1; changed = true; }
  if (!("poll" in data.nextId)) { data.nextId.poll = 1; changed = true; }
  // Older saves may have categories without a subcategories list yet - attach the
  // matching default breakdown by name where we have one, otherwise leave it browsable
  // with no subcategories (e.g. a custom category Sapir added by hand via the admin panel).
  (data.categories || []).forEach((c) => {
    if (!Array.isArray(c.subcategories)) {
      const match = def.categories.find((dc) => dc.name === c.name);
      c.subcategories = match ? match.subcategories : [];
      changed = true;
    }
  });
  (data.freelancers || []).forEach((f) => {
    if (typeof f.viewCount !== "number") { f.viewCount = 0; changed = true; }
    if (typeof f.couponRevealCount !== "number") { f.couponRevealCount = 0; changed = true; }
    if (!f.adPaymentStatus) { f.adPaymentStatus = f.isAdvertised ? "pending_payment" : "none"; changed = true; }
    if (!("logoDataUri" in f)) { f.logoDataUri = null; changed = true; }
    if (!Array.isArray(f.galleryPhotos)) { f.galleryPhotos = []; changed = true; }
    if (!("inspirationQuote" in f)) { f.inspirationQuote = ""; changed = true; }
    if (!("yearsInField" in f)) { f.yearsInField = ""; changed = true; }
    if (!("hasWhatsapp" in f)) { f.hasWhatsapp = false; changed = true; }
    if (!("subcategoryId" in f)) { f.subcategoryId = ""; changed = true; }
    if (!("portfolioUrl" in f)) { f.portfolioUrl = ""; changed = true; }
    if (!("availableNow" in f)) { f.availableNow = false; changed = true; }
    if (!("offersOnline" in f)) { f.offersOnline = false; changed = true; }
    if (!("offersHomeVisit" in f)) { f.offersHomeVisit = false; changed = true; }
    if (!("wantsPushNotifications" in f)) { f.wantsPushNotifications = false; changed = true; }
    if (!Array.isArray(f.additionalCategoryIds)) { f.additionalCategoryIds = []; changed = true; }
    if (!("active" in f)) { f.active = true; changed = true; }
    if (!Array.isArray(f.pushSubscriptions)) { f.pushSubscriptions = []; changed = true; }
    // A freelancer who does a few genuinely different kinds of work (e.g. also does
    // balloons, or also does hair) can register each as its own full mini-listing -
    // own name/category/logo/gallery/deal/description - rather than just tagging her
    // main listing with extra category checkboxes.
    if (!Array.isArray(f.additionalListings)) { f.additionalListings = []; changed = true; }
    if (!("referredByFreelancerId" in f)) { f.referredByFreelancerId = null; changed = true; }
    // The first-login "מזל טוב, את בפנים!!" welcome popup is for the moment a profile gets
    // approved. Freelancers already approved before this feature shipped already had that
    // moment (just without a popup for it) - backfilling them as "seen" avoids surprising
    // long-time freelancers with a "welcome" message out of nowhere. A freelancer who's still
    // pending at migration time gets seen=false, so she still sees it once, the first time she
    // visits her dashboard after an admin actually approves her - same as any new signup.
    if (!("welcomePopupSeen" in f)) { f.welcomePopupSeen = f.status === "approved"; changed = true; }
    // An additional listing can be advertised independently of her main profile - e.g. she
    // may only want to pay to promote her balloon business, not her main makeup business -
    // so each listing gets its own isAdvertised/adPaymentStatus, same shape as the
    // freelancer-level fields above.
    f.additionalListings.forEach((l) => {
      if (!("isAdvertised" in l)) { l.isAdvertised = false; changed = true; }
      if (!l.adPaymentStatus) { l.adPaymentStatus = l.isAdvertised ? "pending_payment" : "none"; changed = true; }
      if (!("yearsInField" in l)) { l.yearsInField = ""; changed = true; }
    });
  });
  (data.customers || []).forEach((c) => {
    if (!Array.isArray(c.revealedCoupons)) { c.revealedCoupons = []; changed = true; }
    if (!Array.isArray(c.pushSubscriptions)) { c.pushSubscriptions = []; changed = true; }
    // Email verification is a new requirement for signups going forward - customers who
    // already had an account before this existed are grandfathered in as verified, so they
    // don't suddenly see a "please verify" nag for an account that's been fine all along.
    if (!("emailVerified" in c)) { c.emailVerified = true; changed = true; }
    if (!("emailVerifyToken" in c)) { c.emailVerifyToken = null; changed = true; }
    if (!("wantsPushNotifications" in c)) { c.wantsPushNotifications = false; changed = true; }
    if (!("referredByCustomerId" in c)) { c.referredByCustomerId = null; changed = true; }
    // Customers who already existed before the referral popup shipped haven't seen it
    // either - they get it once too, the next time they land on their account page.
    if (!("referralPopupSeen" in c)) { c.referralPopupSeen = false; changed = true; }
  });
  (data.admins || []).forEach((a) => {
    if (!Array.isArray(a.pushSubscriptions)) { a.pushSubscriptions = []; changed = true; }
  });
  (data.reviews || []).forEach((r) => {
    if (!("response" in r)) { r.response = ""; changed = true; }
    if (!("responseDate" in r)) { r.responseDate = null; changed = true; }
  });
  // Stories used to be admin-authored only (a single free-text "content" field). Now a
  // freelancer can submit her own via Q&A answers and it goes through a pending/approved
  // flow - older admin-written stories are treated as already-approved since an admin
  // publishing one directly was always an implicit approval.
  (data.stories || []).forEach((s) => {
    if (!Array.isArray(s.answers)) { s.answers = []; changed = true; }
    if (!("status" in s)) { s.status = "approved"; changed = true; }
    if (!("submittedAt" in s)) { s.submittedAt = s.createdAt; changed = true; }
    if (!("approvedAt" in s)) { s.approvedAt = s.createdAt; changed = true; }
    if (!Array.isArray(s.comments)) { s.comments = []; changed = true; }
  });
  // Consultation replies used to be freelancer-only ({ freelancerId, freelancerName }).
  // Customers can now reply too, so replies carry a generic authorRole/authorId/authorName -
  // any older reply saved under the previous shape is treated as a freelancer reply (the only
  // kind that could have existed back then) and reshaped in place.
  (data.consultations || []).forEach((c) => {
    (c.replies || []).forEach((r) => {
      if (!("authorRole" in r)) {
        r.authorRole = "freelancer";
        r.authorId = r.freelancerId;
        r.authorName = r.freelancerName;
        changed = true;
      }
    });
  });
  return changed;
}

let cache = null;

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DB_PATH)) {
    cache = defaultData();
    save();
  } else {
    cache = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (migrate(cache)) save();
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(cache, null, 2), "utf8");
}

function nextId(kind) {
  const d = load();
  const id = String(d.nextId[kind]++);
  save();
  return id;
}

module.exports = { load, save, nextId, DB_PATH };
