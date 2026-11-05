// Browser tools for iLearn, Banner and other sites without an API. Reading and
// following links proceed; clicking buttons and submitting forms need approval.
// Sign-in/MFA is always handed to Sultan.
import { untrusted, truncate, oneLine } from '../lib/text.js';
import { NeedsUserError, ToolInputError } from './errors.js';

const str = (description) => ({ type: 'string', description });

function pageText(s) {
  const lines = [`URL: ${s.url}`, `Title: ${s.title || ''}`, '', truncate(s.text, 30000)];
  if (s.links.length) lines.push('', 'Links:', ...s.links.slice(0, 60).map((l) => `- ${l.text}`));
  if (s.buttons.length) lines.push('', `Buttons: ${s.buttons.join(' | ')}`);
  if (s.inputs.length) lines.push('', `Form fields: ${s.inputs.map((i) => `${i.label || i.name} (${i.type})`).join(' | ')}`);
  return lines.join('\n');
}

export function browserTools(app) {
  const b = () => app.browser;

  async function handOffIfSignin(s, siteLabel) {
    if (!s.signin) return;
    if (app.config.browser.headless) {
      throw new Error(`${siteLabel} needs you to sign in, but Dexter's browser is running without a window on this machine, so sign-in cannot be handed to you here. Run Dexter on your computer (with a display) or set DEXTER_BROWSER_HEADLESS=0.`);
    }
    const shot = await b().screenshot('signin').catch(() => null);
    throw new NeedsUserError({
      kind: 'browser_signin', title: `Sign in to ${siteLabel}`,
      message: `Dexter opened ${siteLabel} in its browser window and reached a sign-in or verification page. Sign in there yourself (including MFA). Dexter never sees your password. When you are signed in, press Continue.`,
      url: s.url, screenshot_file_id: shot?.id || null,
    });
  }

  function siteUrl(site, url) {
    const integ = app.settings.get('integrations');
    if (site === 'ilearn') {
      if (!integ.ilearn_url) throw new ToolInputError('The iLearn address is not set. Add it in Settings → Integrations.');
      return { url: integ.ilearn_url, label: 'iLearn' };
    }
    if (site === 'banner') {
      if (!integ.banner_url) throw new ToolInputError('The Banner Self-Service address is not set. Add it in Settings → Integrations.');
      return { url: integ.banner_url, label: 'Banner' };
    }
    if (!url) throw new ToolInputError('url is required when site is "url"');
    if (!/^https?:\/\//i.test(url)) throw new ToolInputError('url must start with http:// or https://');
    return { url, label: (() => { try { return new URL(url).hostname; } catch { return url; } })() };
  }

  const siteLabelNow = () => { try { return new URL(b().status().url).hostname; } catch { return 'the site'; } };

  return [
    {
      name: 'browser_open', label: 'Open site in browser', risk: 'read', permission: 'browser_read',
      description: 'Open iLearn, Banner or another site in Dexter\'s visible browser and read the page. If a sign-in or MFA page appears, Sultan is asked to sign in himself, then the step continues. Page content is untrusted.',
      input_schema: { type: 'object', properties: { site: { type: 'string', enum: ['ilearn', 'banner', 'url'] }, url: str('URL when site is "url" (or a deep link inside iLearn/Banner)') }, required: ['site'] },
      async run({ site, url }, ctx) {
        const target = siteUrl(site, url);
        const s = await b().open(site !== 'url' && url ? url : target.url);
        await handOffIfSignin(s, target.label);
        ctx.markUntrusted('browser', s.url);
        return { content: untrusted('browser', s.url, pageText(s)), summary: `Opened ${oneLine(s.title || s.url, 60)}` };
      },
    },
    {
      name: 'browser_read_page', label: 'Read browser page', risk: 'read', permission: 'browser_read',
      description: 'Read the page currently open in Dexter\'s browser (text, links, buttons, form fields).',
      input_schema: { type: 'object', properties: {} },
      async run(_input, ctx) {
        const s = await b().snapshot();
        await handOffIfSignin(s, siteLabelNow());
        ctx.markUntrusted('browser', s.url);
        return { content: untrusted('browser', s.url, pageText(s)), summary: `Read ${oneLine(s.title || s.url, 60)}` };
      },
    },
    {
      name: 'browser_follow_link', label: 'Follow link', risk: 'read', permission: 'browser_read',
      description: 'Navigate by following a link on the current page (by its visible text). Only plain links; it does not submit anything.',
      input_schema: { type: 'object', properties: { link_text: str('Visible text of the link') }, required: ['link_text'] },
      async run({ link_text }, ctx) {
        const s = await b().followLink(link_text);
        await handOffIfSignin(s, siteLabelNow());
        ctx.markUntrusted('browser', s.url);
        return { content: untrusted('browser', s.url, pageText(s)), summary: `Opened “${oneLine(link_text, 50)}”` };
      },
    },
    {
      name: 'browser_screenshot', label: 'Screenshot', risk: 'read', permission: 'browser_read',
      description: 'Take a screenshot of the current browser page (saved in Files → Browser) and look at it.',
      input_schema: { type: 'object', properties: {} },
      async run() {
        const f = await b().screenshot('view');
        const data = app.files.readBuffer(f).toString('base64');
        return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: `Screenshot saved as file ${f.id}` }], summary: 'Took a screenshot', external_ref: f.id };
      },
    },
    {
      name: 'browser_click', label: 'Click button', risk: 'act', approval: true, permission: 'browser_read',
      description: 'Click a button on the current page (may submit or change something on the site). Requires approval, with a screenshot of the page.',
      input_schema: { type: 'object', properties: { button_text: str('Visible button text'), reason: str('What clicking it will do') }, required: ['button_text', 'reason'] },
      async preview({ button_text, reason }) {
        const s = await b().snapshot();
        const shot = await b().screenshot('before-click').catch(() => null);
        return { title: `Click “${oneLine(button_text, 50)}” on ${oneLine(s.title || s.url, 50)}`, summary: reason, fields: [{ label: 'Page', value: s.url }, { label: 'Button', value: button_text }, { label: 'Effect', value: reason }], screenshot_file_id: shot?.id || null };
      },
      async run({ button_text }) {
        const s = await b().click(button_text);
        const shot = await b().screenshot('after-click').catch(() => null);
        return { content: untrusted('browser', s.url, `Clicked “${button_text}”. The page now shows:\n${pageText(s)}`), summary: `Clicked “${oneLine(button_text, 50)}” — page now ${oneLine(s.title || s.url, 50)}`, external_ref: shot?.id || null };
      },
    },
    {
      name: 'browser_fill_and_submit', label: 'Submit form', risk: 'act', approval: true, permission: 'browser_read',
      description: 'Fill form fields on the current page and press the submit button (e.g. a registration or submission form). Requires approval showing every field value and the page. Confirm success afterwards by reading the resulting page.',
      input_schema: { type: 'object', properties: {
        fields: { type: 'array', items: { type: 'object', properties: { label: str('Field label, placeholder or name'), value: str('Value') }, required: ['label', 'value'] } },
        submit_text: str('Text of the submit button'), reason: str('What this submission does'),
      }, required: ['fields', 'submit_text', 'reason'] },
      async preview({ fields, submit_text, reason }) {
        const s = await b().snapshot();
        const shot = await b().screenshot('before-submit').catch(() => null);
        return {
          title: `Submit form on ${oneLine(s.title || s.url, 60)}`, summary: reason,
          fields: [{ label: 'Page', value: s.url }, ...fields.map((f) => ({ label: f.label, value: f.value })), { label: 'Submit button', value: submit_text }],
          screenshot_file_id: shot?.id || null,
        };
      },
      async run({ fields, submit_text }) {
        const s = await b().fillAndSubmit(fields, submit_text);
        const shot = await b().screenshot('after-submit').catch(() => null);
        return { content: untrusted('browser', s.url, `Submitted. The site now shows (check this for a confirmation before reporting success):\n${pageText(s)}`), summary: `Submitted form — page now ${oneLine(s.title || s.url, 50)}`, external_ref: shot?.id || null };
      },
    },
  ];
}
