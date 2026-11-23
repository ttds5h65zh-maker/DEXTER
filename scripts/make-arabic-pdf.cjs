const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.setContent(`<!doctype html><meta charset="utf-8"><body style="font:14pt 'DejaVu Sans',sans-serif">
  <p>Notice from the fictional Falcon Bay housing office.</p>
  <p dir="rtl">الامتحان في 5 ديسمبر 2026 الساعة 10:00 في القاعة B</p>
  <p dir="rtl">يرجى دفع الرسوم قبل يوم الخميس.</p>
  <p>The Arabic word مرحبا sits inside an English sentence.</p></body>`);
  await p.pdf({ path: process.argv[2] });
  await b.close();
})();
