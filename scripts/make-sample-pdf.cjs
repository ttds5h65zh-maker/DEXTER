// Regenerates samples/course-outline.pdf (a fictional course outline) with headless Chromium.
// Needs Playwright; only used to rebuild the sample, never by the app.
const { chromium } = require('playwright');
const path = require('node:path');
const html = `<!doctype html><meta charset="utf-8"><style>
body{font:11.5pt/1.5 Georgia,serif;margin:0;color:#111} h1{font-size:19pt;margin:0 0 4pt} h2{font-size:13pt;margin:16pt 0 4pt}
.tag{font:9pt Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#555} .pb{break-before:page}</style>
<p class="tag">Falcon Bay University (fictional) · Sample document for Dexter</p>
<h1>ENGR 412: Systems Design Studio</h1>
<p>Course outline and assessment notes, Autumn term. Instructor: Dr. Laila Haddad. This outline replaces the version circulated in week one.</p>
<h2>Assessment schedule</h2>
<p>The individual design journal is due on 27 November 2026 at 11:59 PM through the course portal. Late journals lose five marks per day.</p>
<p>Team prototype demonstrations take place on 3 December 2026 in Lab C-110. Each team must register a demonstration slot by 24 November 2026.</p>
<p>The peer review form must be submitted within 5 days of your demonstration.</p>
<h2>Changes agreed with the class</h2>
<p>The class agreed to replace the written midterm with a design critique. The teaching team decided that attendance at the critique counts for ten percent of the final grade.</p>
<div class="pb"></div>
<h2>Open points</h2>
<p>It is still unclear whether the workshop will be open on Saturdays; the facilities office has not confirmed. Do teams need extra fabrication time before the demonstrations?</p>
<p>Please send any accessibility requests to the course coordinator by the end of next week.</p>
<h2>Final report</h2>
<p>The final team report is due next Thursday after the demonstrations at 5pm. Submit one PDF per team.</p>`;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(__dirname, '..', 'samples', 'course-outline.pdf'), format: 'A4', margin: { top: '22mm', bottom: '22mm', left: '22mm', right: '22mm' } });
  await browser.close();
})();
