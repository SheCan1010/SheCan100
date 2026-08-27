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
      // כל כמה ימים הסיפור המוצג ב-/stories מתחלף - ניתן לעריכה בפאנל הניהול. ברירת המחדל
      // שבוע (7). שינוי הערך משפיע קדימה בלבד - המחזור הבא יחושב לפי המספר החדש, בלי לזוז
      // אחורה בזמן.
      storyRotationDays: 7,
      // דגל חד-פעמי: מסמן שכבר בוצע גיבוי-לאחור (backfill) שמילא s.featuredAt לכל הסיפורים
      // שכבר היה להם תור לפני שהשדה הזה נוסף - ר' getCurrentStory ב-server.js.
      storiesFeaturedBackfilled: false,
      // דגל חד-פעמי נוסף: מסמן שכל התמונות המוטמעות (base64) בתוך db.json כבר "הוצאו" לקבצים
      // נפרדים בתיקיית uploads (ר' migrateEmbeddedPhotosToFiles ב-server.js) - זה מה שתיקן את
      // קריסת הזיכרון מ-22.8.2026, אחרי שהתגלה ש-db.json תפח לכ-290MB.
      photosMigratedToFiles: false,
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
      // חותמת הזמן האחרונה שבה ספיר "פינגה" מתוך פאנל הניהול (ר' POST /admin/support/heartbeat,
      // נשלח אוטומטית ברקע כל עוד היא מחוברת כאדמין ונמצאת באיזשהו עמוד ניהול) - משמש כדי
      // להראות לשואלת ב-"לתמיכה לחצי" אם ספיר "מחוברת עכשיו" (צ'אט חי) או לא (משאירה הודעה).
      adminSupportActiveAt: null,
      searchEngineVisible: false, // כל עוד false - האתר חסום למנועי חיפוש (Google וכו')
      showPublicStats: false, // הצגת "הקהילה שלנו במספרים" (עצמאיות/לקוחות/עסקאות שנסגרו) בעמוד הבית לכולן - כבוי כברירת מחדל, מופעל בפאנל הניהול
      // "בקשות שירות" (נוסף 2026-08-26) - לקוחה מפרסמת בקשה לשירות ספציפי (ר' d.serviceRequests
      // למטה), שמופיעה לעצמאיות בתחום המתאים. כל עוד false (ברירת המחדל) - פתוח לכולן; true =
      // מוצג רק לעצמאיות עם tier==="premium" (אותו שדה tier הקיים כבר לרמת "מומלצת"/pricing.
      // premium - ר' ההערה על POST /admin/freelancer/:id/toggle-tier ב-server.js). לפי בקשה
      // מפורשת: "כל עוד לא סימנתי שזה בתשלום זה יהיה פתוח לכולן".
      serviceRequestsPremiumOnly: false,
      communityWhatsappLink: "", // קישור הצטרפות לקבוצת הוואטסאפ - להשלים בפאנל הניהול
      contactEmail: "", // מייל ליצירת קשר - להשלים בפאנל הניהול
      adPrice: null, // מחיר ייחוס למודעה בצד העמוד (₪ לחודש) - להשלים בפאנל הניהול
      pricing: { basic: 49, premium: 109 },
      siteLogoDataUri: null, // לוגו מותאם אישית (מוחלף על הוורדמארק "SheCan") - להעלאה בפאנל הניהול
      showLogoOnDealBadge: false, // האם להציג את siteLogoDataUri ליד תגית "הטבת SheCan" על הכרטיסיות בגריד
      // "לוגו ברירת מחדל לעסקים" (נוסף 2026-08-26) - לכל עסק שאין לו תמונת פרופיל (photoDataUri)
      // ולא העלה לוגו משלו (logoDataUri), במקום התחלת שם ("ראשי תיבות") באנגלית מוצג הלוגו הזה
      // אוטומטית - ר' avatarUri ב-server.js, שמשמש כברירת מחדל בכל מקום שמציג תמונת/לוגו עסק
      // (כרטיסיית מודעה/עסק מוביל בסיידבר, כרטיסיית עסק בגריד, עמוד הפרופיל המלא וכו').
      // ספיר יכולה תמיד להחליף אותו דרך פאנל הניהול (בדיוק כמו siteLogoDataUri למעלה) - וכל
      // עסק שכן מעלה תמונה/לוגו משלו ממשיך להציג את שלו כרגיל, זה רק כברירת מחדל.
      defaultBusinessLogoDataUri: "data:image/png;base64,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",
      weeklyMessageLikeCount: 0, // סופרת לייקים למשפט השבוע כשאין עצמאית משויכת (הודעת ברירת המחדל של המנהלת)
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
      // "מאגרי קהילה" (נוסף 2026-08-26) - מחיר אופציונלי לכל אחד מ-8 סוגי המאגר (0 = בחינם),
      // נשמר ברקע דרך פאנל הניהול - ר' communityTypePricing ב-server.js (POST /admin/community-price).
      communityTypePricing: { gemach: 0, rental: 0, workshop: 0, class: 0, giveaway: 0, sale: 0, dressWanted: 0, tutor: 0, product: 0 },
    },
    contactMessages: [], // הודעות שהושארו בעמוד "צרי קשר"
    // "לתמיכה לחצי 💬" - כפתור צף שמופיע בכל עמוד באתר, לכל מי שנכנסת (כולל גולשות שלא
    // נרשמו). שואלת מזוהה: לקוחה/עצמאית מחוברת לפי session (voterKey "customer:<id>" /
    // "freelancer:<id>"), גולשת לא מחוברת לפי אותו cookie אנונימי קבוע (scAnon) שכבר משמש
    // להצבעות ב"זירה" - כדי שהיא תוכל לראות את השיחה שלה גם בלי חשבון, מאותו דפדפן.
    // זו רשימה שטוחה של הודעות בודדות בתוך שיחה - בדיוק כמו chatMessages למעלה, רק בין
    // שואלת (from:"asker") לבין ספיר (from:"admin") - כל ההודעות עם אותו voterKey שייכות
    // לאותה שיחה. כשספיר "מחוברת" (settings.adminSupportActiveAt מעודכן ב-90 השניות
    // האחרונות - ר' POST /admin/support/heartbeat) ההודעות מוצגות/מתעדכנות כמו צ'אט חי עם
    // polling; כשהיא לא מחוברת, השואלת משאירה הודעה וממתינה - התשובה שלה תגיע גם באתר עצמו
    // (בפעם הבאה שהיא פותחת את /support מאותו דפדפן) וגם למייל שהיא השאירה.
    // { id, voterKey, name, email, from: "asker"|"admin", text, createdAt, read }
    supportMessages: [],
    couponRevealEvents: [], // לוג גלובלי של כל לחיצה על "לצפייה בקוד קופון" - freelancerId + date
    // מונה כניסות לאתר - נספר בכל טעינת עמוד ציבורית (לא כולל אזור ניהול/דשבורד עצמאית/API
    // פנימי). totalVisits הוא הסה"כ המצטבר, dailyVisits הוא מיפוי תאריך (YYYY-MM-DD) -> מספר
    // כניסות באותו יום, כדי שאפשר יהיה להציג גם מגמה של הימים האחרונים ולא רק מספר אחד יבש.
    siteStats: { totalVisits: 0, dailyVisits: {} },
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
    // "סקר מהמערכת" (נוסף ב-2026-08-25): ספיר עצמה יכולה גם ליצור סקר, דרך פאנל הניהול -
    // נשמר באותו מערך, רק עם source:"admin" (freelancerId: null, freelancerName: "SheCan")
    // ו-audience: "freelancers"|"customers"|"both", שקובע מי בכלל רואה ויכולה להצביע בו
    // (ר' pollVisibleToMe ב-server.js). סקר של עצמאית (ללא source, או source !== "admin")
    // ממשיך להיות גלוי לכולן כרגיל, ואין הגבלת "סקר אחד בשבוע" לספיר.
    polls: [],
    // "כניסה אחרונה לזירה" (נוסף 2026-08-26) - מתי לקוחה/עצמאית מחוברת ביקרה לאחרונה ב-/arena,
    // כדי שנוכל לסמן לה תג "חדש" ליד כפתור "🥊 הזירה" בתפריט כשיש סקר מהמערכת (source:"admin")
    // שמיועד לקהל שלה ופורסם אחרי הביקור האחרון שלה - בלי לדרוש שהיא כבר תפתח את הזירה כדי לדעת
    // שיש שם משהו חדש. מפתח: "customer:<id>" או "freelancer:<id>", ערך: ISO timestamp.
    // אורחת לא מחוברת לא מקבלת תג (בדיוק כמו שאר תגי ה"חדש" באתר, הכל מבוסס-חשבון).
    arenaLastSeen: {},
    // "כניסה אחרונה למאגרי קהילה" (נוסף 2026-08-26) - אותו רעיון בדיוק כמו arenaLastSeen למעלה,
    // אבל עבור /community - מתי לקוחה מחוברת ביקרה לאחרונה בעמוד הראשי או בעמוד סוג ספציפי,
    // כדי לסמן לה תג "חדש" ליד כפתור "קהילת SheCan" בתפריט כשיש פריט מסירה/מכירת יד 2 חדש
    // בקטגוריה שסימנה שמעניינת אותה (ר' communityNotifyTags על רשומת הלקוחה, ו-
    // communityUnseenCount ב-layout.js). מפתח: "customer:<id>", ערך: ISO timestamp - רק לקוחות
    // (לא עצמאיות) כי רק לקוחות יכולות להירשם להתראות קטגוריה כרגע.
    communityLastSeen: {},
    // "מודליסטיות נדרשות" - עצמאית מפרסמת בקשה לעזרה ממודליסטית/תופרת (פרטים/מיקום/מתי),
    // כל גולשת (לקוחה או לא) יכולה לצפות ולפנות אליה דרך מערכת ההודעות הקיימת
    // (POST /freelancer/:id/message, כמו בכל פנייה אחרת לעצמאית). הבקשה מוסרת רק ע"י
    // העצמאית שפרסמה אותה, לאחר בדיקת בעלות (freelancerId === session.id) - בדיוק כמו
    // דפוס המחיקה העצמית של polls/arenaQuestions/consultations למעלה.
    // price הוא שדה חופשי, ברירת מחדל "ללא תשלום" כשלא מולא (ר' migrate למטה לגבי בקשות ישנות).
    // { id, freelancerId, freelancerName, details, location, when, price, createdAt }
    patternmakerRequests: [],
    // "בקשות שירות" (נוסף 2026-08-26) - ההפך מ-patternmakerRequests למעלה: כאן לקוחה מפרסמת
    // בקשה לשירות ספציפי (למשל "מעצבת שיער ל-2 אחיות בראשון לציון, 14.9, עד 500 ש\"ח"),
    // ממוינת לפי קטגוריה/תת-קטגוריה - לא לוח פתוח לכולן כמו מודליסטיות, אלא "ליד" ממוקד:
    // מוצג רק לעצמאיות באותה קטגוריה (ר' GET /freelancer-dashboard), ורק למי שמסומנת
    // tier==="premium" אם d.settings.serviceRequestsPremiumOnly דלוק (אחרת פתוח לכל עצמאית
    // מאושרת בקטגוריה, ר' ההערה על הדגל הזה למעלה). editedAt מתעדכן בכל עריכה של הלקוחה -
    // העצמאיות רואות תמיד את הגרסה החיה של הרשומה (אין העתק/הקפאה), כך ש"עריכה מתעדכנת
    // אוטומטית" בלי צורך בקוד נוסף. מחיקה רק ע"י הלקוחה שפרסמה (בדיקת בעלות) או אדמין.
    // { id, customerId, categoryId, subcategoryId, title, description, eventDate, budget,
    //   peopleCount, cityId, phone, hasWhatsapp, email, createdAt, updatedAt }
    serviceRequests: [],
    // "מאגרי קהילה" (נוסף 2026-08-26) - שמונה סוגי משאבים קהילתיים שכולם חיים באותה רשימה
    // אחת, מובחנים לפי type - ר' COMMUNITY_TYPES ב-server.js לפירוט המלא של כל סוג (תווית,
    // אייקון, תגיות משנה). tag הוא תת-קטגוריה חופשית מתוך רשימת התגים של אותו type.
    // "giveaway" (מסירות) ו-"sale" (מכירת יד 2) שונים מ-6 הסוגים האחרים: פרסום פריט בהם דורש
    // חשבון לקוחה מחובר (ownerCustomerId), כדי שהמפרסמת תוכל אחר כך להיכנס ל"אזור האישי" שלה
    // ולהוריד את הפריט בעצמה ברגע שהוא כבר נמסר/נמכר - ר' POST /account/community/:id/take-down.
    // "product" (המלצות מוצרים) הוא תוכן ביקורת (UGC), לא שירות עם פרטי קשר - model/price/
    // whereBought מחליפים שם את city/address/phone/email. "sale" משתמש גם ב-price וגם
    // ב-city/address/phone/email יחד, כי זו עדיין עסקה בין שתי אנשים עם יצירת קשר אמיתית.
    // "rental" (השכרות) מקבל בנוסף color/length/audience/priceNum - רלוונטי רק לפריטי שמלות
    // ערב (tag===DRESS_TAG ב-server.js), משמש לסינון לפי צבע/אורך/קהל יעד/מחיר מקסימלי
    // בעמוד /community/rental. priceNum הוא הפירוש המספרי של price (למשל "150 ₪" -> 150),
    // מחושב אוטומטית ב-server.js (parsePriceNum) בכל שמירה - לא מוזן ידנית.
    // "dressWanted" (דרושות שמלות, נוסף לפי בקשה מפורשת) - סוג פתוח רגיל בלי שדות ייחודיים
    // משלו, לקוחה שמחפשת שמלה מפרסמת בקשה עם פרטי קשר, בדיוק כמו gemach/rental/workshop.
    // { id, type, title, tag, cityId, address, description, phone, hasWhatsapp, email,
    //   photoDataUri, contactName, model, price, whereBought, color, length, audience,
    //   priceNum, ownerCustomerId, source: "self"|"admin",
    //   status: "pending"|"approved"|"rejected", viewCount, createdAt, approvedAt }
    communityListings: [],
    // "מתחזקות ומחזקות" - קהילת תהילים (נוסף 2026-08-26). שני אוספים (הקבלות עצמן מקוננות
    // בתוך tehillimNames, לא אוסף נפרד - ר' הערה שם):
    // tehillimBooks - ה"ספרים" עצמם, שני זרמים מקבילים שרצים במקביל כל הזמן: division==="daily"
    // (מחולק ל-7 חלקים לפי ימות השבוע - "יומי" כאן פירושו "יום בשבוע", לא "יום בחודש", כי
    // רק החלוקה השבועית המסורתית נמצאה ואומתה ממקור מהימן - ר' TEHILLIM_WEEKLY_DIVISION
    // ב-server.js) ו-division==="chapters" (מחולק ל-150 פרקים בודדים, TEHILLIM_CHAPTERS_DIVISION).
    // תמיד יש לכל היותר ספר אחד "open" בכל division - ר' ensureOpenTehillimBook ב-server.js
    // שיוצרת ספר חדש אוטומטית כשאין כזה או כשהקיים התמלא. units הוא מערך במבנה הזהה לאורך
    // החלוקה (7 או 150), כל איבר: { index, label, from, to (טווח פרקים), claimedByCustomerId:
    // id|null, claimedAt, read: boolean, readAt }. כשכל ה-units מסומנים read=true הספר עובר
    // status "closed" (closedAt נשמר) ומיד נפתח ספר הבא (createTehillimBook). status: "open"|"closed".
    // קריאת הפרק בפועל היא קישור חיצוני ל-Sefaria.org (sefariaChapterLink) - הטקסט הקדוש עצמו
    // לא מוטמע באתר, כדי לא להסתכן באי-דיוק; הסימון "קראתי" נשאר בתוך SheCan.
    // { id, division: "daily"|"chapters", status, units: [...], createdAt, closedAt }
    tehillimBooks: [],
    // tehillimNames - רשימת השמות לתפילה שנוספה ע"י לקוחות מחוברות, עד 2 שמות בכל הוספה (לא מגבלה
    // כוללת - אפשר להוסיף שוב בהמשך). story הוא סיפור קצר אופציונלי שעומד מאחורי הבקשה. kabbalot
    // הן "קבלות" שלקוחות אחרות כותבות לזכות השם הזה (ר' TEHILLIM_KABBALAH_OPTIONS ב-server.js
    // לרשימת 4 האופציות + "אחר" חופשי) - מקוננות ישירות בתוך רשומת השם (לא אוסף נפרד), כל איבר:
    // { id, customerId, type, customText, createdAt }. מחיקת שם ע"י הלקוחה שהוסיפה (customerId)
    // או אדמין בלבד; מחיקת קבלה בודדת ע"י מי שכתבה אותה (kabbalot[].customerId) או אדמין בלבד.
    // { id, customerId, names: [string, string?], story, kabbalot: [...], createdAt }
    tehillimNames: [],
    // tehillimSalvationStories - "סיפורי ישועה" שלקוחות מוסיפות בזכות התהילים, מוצג בתחתית עמוד
    // /community/tehillim. מחיקה ע"י הכותבת (customerId) או אדמין בלבד.
    // { id, customerId, text, createdAt }
    tehillimSalvationStories: [],
    // "המשך טיפול" (נוסף 2026-08-26) - רשימת "מפתחות" של פריטים בתורי האישור השונים (עצמאית/
    // ביקורת/סיפור/שאלת זירה/התייעצות/תחום נוסף/פריט מאגר קהילה) שהמנהלת בחרה להזיז הצידה
    // ולטפל בהם מאוחר יותר - ר' isSnoozed/snoozeButtonHtml ב-server.js. key מזהה את הרשומה
    // המקורית (למשל "freelancer:42"), ה-status האמיתי של הרשומה לא משתנה בכלל - זו רק "מסננת
    // תצוגה" שמסתירה אותה מהתור עד שהמנהלת לוחצת "החזרה לתור האישורים" (POST /admin/unsnooze).
    // { key, itemType, itemLabel, snoozedAt }
    adminSnoozed: [],
    // "המלצות לתת-תחום חדש" (נוסף 2026-08-27) - עצמאית שנרשמת/מעדכנת פרופיל ולא מוצאת תת-תחום
    // מתאים ברשימה הקיימת יכולה רק "להמליץ" על תת-תחום חדש בטופס (ר' subcategorySuggestion
    // ב-body של POST /join ו-POST /freelancer-dashboard) - זה לא יוצר תת-תחום חי מיד כמו
    // שהיה קודם, אלא רק רשומה כאן שממתינה לאישור המנהלת. אישור (POST /admin/subcategory-
    // suggestion/:id/approve) יוצר בפועל תת-תחום אמיתי דרך findOrCreateSubcategory (וקושר
    // אותו לעצמאית ששלחה את ההמלצה, אם היא עדיין בלי תת-תחום), ורק מאותו רגע הוא מופיע בכל
    // התפריטים באתר. status: "pending" | "approved" | "rejected" (לא נמחק גם אחרי דחייה, כמו
    // שאר תורי האישור באתר - נשאר להיסטוריה).
    // { id, categoryId, name, freelancerId, freelancerLabel, status, createdAt }
    subcategorySuggestions: [],
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
      "נתניה", "באר שבע", "חולון", "רמת גן", "בת ים", "רחובות",
      "אשקלון", "הרצליה", "כפר סבא", "רעננה", "מודיעין", "נס ציונה",
      "קריית אונו", "הוד השרון", "עפולה", "נהריה", "אילת", "טבריה",
      "כרמיאל", "בני ברק", "בית שמש", "חדרה", "לוד", "רמלה",
      "נצרת", "גבעתיים", "קריית אתא", "רהט", "קריית גת", "קריית מוצקין",
      "אור יהודה", "צפת", "נתיבות", "דימונה", "יבנה", "אום אל-פחם",
      "שפרעם", "קריית ים", "קריית מלאכי", "קריית ביאליק", "אריאל", "טייבה",
      "סח'נין", "טירה", "אור עקיבא", "נשר", "מגדל העמק", "יהוד-מונוסון",
      "קריית שמונה", "ראש העין", "גבעת שמואל", "אלעד", "באקה אל-גרביה", "טמרה",
      "ג'לג'וליה", "עכו", "בית שאן", "יקנעם עילית", "כפר קאסם", "כפר יונה",
      "נוף הגליל", "מעלה אדומים", "ביתר עילית", "מודיעין עילית", "שוהם", "פרדס חנה-כרכור",
      "זכרון יעקב", "גדרה", "כוכב יאיר-צור יגאל", "קדימה-צורן", "אבן יהודה", "בנימינה-גבעת עדה",
      "גני תקווה", "קריית טבעון", "מזכרת בתיה", "באר יעקב", "עתלית", "דלית אל-כרמל",
      "עוספיה", "כפר מנדא", "כפר קרע", "ערערה", "ג'ת", "כאבול",
      "ריינה", "איכסאל", "כפר כנא", "מע'אר", "דבוריה", "נחף",
      "ג'דיידה-מכר", "אעבלין", "כפר יאסיף", "אבו סנאן", "שגב-שלום", "ערד",
      "מצפה רמון", "ירוחם", "כסייפה", "לקיה", "חורה", "תל שבע",
      "אבו גוש", "מבשרת ציון", "הר אדר", "אלקנה", "אורנית", "קרני שומרון",
      "אפרת", "קריית ארבע", "מעלות-תרשיחא", "שלומי", "ראש פינה", "חצור הגלילית",
      "כפר ורדים", "מגדל", "בית ג'ן", "ג'סר א-זרקא", "פוריידיס", "בוקעאתא",
      "מג'דל שמס", "יאנוח-ג'ת",
    ].map((name, i) => ({ id: String(i + 1), name })),
    freelancers: [],
    customers: [],
    reviews: [],
    magazines: [],
    stories: [], // "סיפור השראה שבועי" - ראיון/פוסט שספיר מעלה ידנית על עצמאית אחת - { id, title, freelancerId, content, photoDataUri, createdAt }
    admins: [
      { id: "1", email: "admin@shecan.co.il", name: "ספיר", passwordHash: null, pushSubscriptions: [] },
    ],
    nextId: { freelancer: 1, customer: 1, review: 1, magazine: 1, coupon: 110, message: 1, chat: 1, story: 1, storyComment: 1, listing: 1, arenaQuestion: 1, arenaAnswer: 1, consultation: 1, consultationReply: 1, poll: 1, deal: 1, adminMessage: 1, patternmakerRequest: 1, supportMessage: 1, communityListing: 1 },
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
  if (!data.arenaLastSeen || typeof data.arenaLastSeen !== "object") { data.arenaLastSeen = {}; changed = true; }
  if (!data.communityLastSeen || typeof data.communityLastSeen !== "object") { data.communityLastSeen = {}; changed = true; }
  if (!Array.isArray(data.patternmakerRequests)) { data.patternmakerRequests = []; changed = true; }
  if (!Array.isArray(data.serviceRequests)) { data.serviceRequests = []; changed = true; }
  if (!Array.isArray(data.tehillimBooks)) { data.tehillimBooks = []; changed = true; }
  if (!Array.isArray(data.tehillimNames)) { data.tehillimNames = []; changed = true; }
  if (!Array.isArray(data.tehillimSalvationStories)) { data.tehillimSalvationStories = []; changed = true; }
  if (!Array.isArray(data.adminSnoozed)) { data.adminSnoozed = []; changed = true; }
  if (!Array.isArray(data.subcategorySuggestions)) { data.subcategorySuggestions = []; changed = true; }
  // מוודא ש-kabbalot תמיד קיים כמערך על כל רשומת שם ישנה (הגנה זהה לזו שמעל, לרמה מקוננת).
  (data.tehillimNames || []).forEach((n) => { if (!Array.isArray(n.kabbalot)) { n.kabbalot = []; changed = true; } });
  // מוסיף claimed לכל יחידה ישנה שנוצרה לפני שהשדה הזה נוסף (2026-08-26, כשנפתחה האפשרות
  // לקחת יחידה גם בלי התחברות) - claimed נגזר מ-claimedByCustomerId הישן כדי לא לאבד מצב
  // "נלקח" קיים על יחידות שכבר נלקחו ע"י לקוחה מחוברת לפני העדכון.
  (data.tehillimBooks || []).forEach((b) => {
    (b.units || []).forEach((u) => { if (typeof u.claimed !== "boolean") { u.claimed = Boolean(u.claimedByCustomerId); changed = true; } });
  });
  // מתקן תוויות ישנות של ספר "לפי פרקים" שנוצר לפני שהתווית עברה לגימטריה עברית (2026-08-26)
  // - הספר נוצר עם label בפורמט "פרק 1", "פרק 2" שנשמר כמחרוזת קבועה בזמן היצירה (לא מחושב
  // מחדש אוטומטית כשהקוד מתעדכן), אז צריך לעדכן בפועל את הרשומות הקיימות ל"פרק א'", "פרק ב'"
  // וכו' - זהה בדיוק לפונקציה hebrewGematria ב-server.js. רק division==="chapters" (שם כל
  // יחידה = פרק בודד אחד, from===to) - "daily" (ימות השבוע) לא נוגע בזה בכלל.
  function hebrewGematriaLabel(num) {
    const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
    const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
    const hundreds = num >= 100 ? "ק" : "";
    const rest = num % 100;
    let restLetters;
    if (rest === 15) restLetters = "טו";
    else if (rest === 16) restLetters = "טז";
    else restLetters = tens[Math.floor(rest / 10)] + ones[rest % 10];
    const letters = hundreds + restLetters;
    if (letters.length <= 1) return letters + "'";
    return letters.slice(0, -1) + "\"" + letters.slice(-1);
  }
  (data.tehillimBooks || []).forEach((b) => {
    if (b.division !== "chapters") return;
    (b.units || []).forEach((u) => {
      const correctLabel = `פרק ${hebrewGematriaLabel(u.from)}`;
      if (u.label !== correctLabel) { u.label = correctLabel; changed = true; }
    });
  });
  if (!Array.isArray(data.communityListings)) { data.communityListings = []; changed = true; }
  (data.communityListings || []).forEach((c) => {
    if (typeof c.viewCount !== "number") { c.viewCount = 0; changed = true; }
  });
  // favoriteNotes (הערות אישיות ליד עצמאית שאהבה) ו-communityNotifyTags (הרשמה להתראות קטגוריה
  // במסירות/מכירת יד 2) נוספו ב-2026-08-26 - כל לקוחה קיימת בלי אחד מהם מקבלת אובייקט ריק.
  (data.customers || []).forEach((c) => {
    if (!c.favoriteNotes || typeof c.favoriteNotes !== "object") { c.favoriteNotes = {}; changed = true; }
    if (!c.communityNotifyTags || typeof c.communityNotifyTags !== "object") { c.communityNotifyTags = {}; changed = true; }
  });
  if (!Array.isArray(data.supportMessages)) { data.supportMessages = []; changed = true; }
  // supportMessages היה במקור רשומה אחת לכל שאלה (question/answer/status) - שודרג לצ'אט
  // אמיתי (הודעות בודדות עם from:"asker"/"admin"). כל רשומה ישנה בצורה הזו מפוצלת להודעת
  // שואלת אחת, ובנוסף הודעת admin אם כבר היתה תשובה - כדי לא לאבד שום שיחה שכבר התקיימה
  // לפני השדרוג.
  {
    const upgraded = [];
    let needsUpgrade = false;
    (data.supportMessages || []).forEach((m) => {
      if (m.from === "asker" || m.from === "admin") { upgraded.push(m); return; }
      needsUpgrade = true;
      upgraded.push({
        id: m.id, voterKey: m.voterKey, name: m.name, email: m.email,
        from: "asker", text: m.question || "", createdAt: m.createdAt, read: true,
      });
      if (m.status === "answered" && m.answer) {
        upgraded.push({
          id: `${m.id}-a`, voterKey: m.voterKey, name: m.name, email: m.email,
          from: "admin", text: m.answer, createdAt: m.answeredAt || m.createdAt, read: true,
        });
      }
    });
    if (needsUpgrade) { data.supportMessages = upgraded; changed = true; }
  }
  // שדה price נוסף אחרי שכבר היו בקשות בלי אותו - כל בקשה ישנה בלי price מקבלת "ללא תשלום"
  // בברירת מחדל, בדיוק כמו בקשה חדשה שנשלחת ריקה בשדה הזה.
  (data.patternmakerRequests || []).forEach((r) => {
    if (!r.price) { r.price = "ללא תשלום"; changed = true; }
  });
  if (!data.siteStats || typeof data.siteStats !== "object") { data.siteStats = { totalVisits: 0, dailyVisits: {} }; changed = true; }
  if (typeof data.siteStats.totalVisits !== "number") { data.siteStats.totalVisits = 0; changed = true; }
  if (!data.siteStats.dailyVisits || typeof data.siteStats.dailyVisits !== "object") { data.siteStats.dailyVisits = {}; changed = true; }
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
  if (!("patternmakerRequest" in data.nextId)) { data.nextId.patternmakerRequest = 1; changed = true; }
  if (!("communityListing" in data.nextId)) { data.nextId.communityListing = 1; changed = true; }
  if (!("supportMessage" in data.nextId)) { data.nextId.supportMessage = 1; changed = true; }
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
    if (typeof f.weeklyQuoteLikeCount !== "number") { f.weeklyQuoteLikeCount = 0; changed = true; }
    if (typeof f.couponRevealCount !== "number") { f.couponRevealCount = 0; changed = true; }
    if (typeof f.siteVisitCount !== "number") { f.siteVisitCount = 0; changed = true; }
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
    // Set (2026-08-25) whenever she just introduced a brand-new subcategory at signup or via a
    // later profile edit - see resolveCategorySelection/customSubcategoryNoteHtml in server.js.
    // Surfaces a one-time review highlight for Sapir in the admin panel; cleared once she
    // renames/confirms it there. Existing freelancers obviously never triggered this, so false.
    if (!("customSubcategoryPending" in f)) { f.customSubcategoryPending = false; changed = true; }
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
    if (typeof c.siteVisitCount !== "number") { c.siteVisitCount = 0; changed = true; }
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
  // The cities list grows over time (Sapir asked to add many more Israeli cities/towns
  // that weren't in the original short list) - merge in any default city that isn't
  // already present (matched by name) rather than overwriting, so existing freelancers'
  // cityId references and any cities added by hand via the admin panel stay intact.
  if (Array.isArray(data.cities)) {
    const existingNames = new Set(data.cities.map((c) => c.name.trim().toLowerCase()));
    let nextCityNum = data.cities.length + 1;
    def.cities.forEach((c) => {
      if (!existingNames.has(c.name.trim().toLowerCase())) {
        data.cities.push({ id: String(nextCityNum++), name: c.name });
        existingNames.add(c.name.trim().toLowerCase());
        changed = true;
      }
    });
  } else {
    data.cities = def.cities;
    changed = true;
  }
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
  // Self-healing for any kind that wasn't in the original defaultData() nextId object (e.g.
  // added to the app after Sapir's production db.json was already created) - without this,
  // d.nextId[kind]++ on an unknown key would silently become NaN forever (undefined++ === NaN,
  // and NaN++ stays NaN), so every "new" id from that point on would collide as the string
  // "NaN". Starting it at 1 the first time it's ever requested keeps ids unique either way.
  if (typeof d.nextId[kind] !== "number" || Number.isNaN(d.nextId[kind])) d.nextId[kind] = 1;
  const id = String(d.nextId[kind]++);
  save();
  return id;
}

module.exports = { load, save, nextId, DB_PATH };
