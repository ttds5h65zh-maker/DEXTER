// One place that reports what is connected, for the UI and for the model's context.
export function createIntegrations(app) {
  function status() {
    const google = app.google.status();
    const browser = app.browser.status();
    const model = app.settings.get('model');
    const notif = app.settings.get('notifications');
    const integ = app.settings.get('integrations');
    return {
      anthropic: {
        configured: Boolean(app.config.anthropic.apiKey),
        model: model.id,
        setup: app.config.anthropic.apiKey ? null : 'Add ANTHROPIC_API_KEY=… to the .env file in the Dexter folder and restart Dexter.',
      },
      google: {
        ...google,
        setup: google.configured ? null : `Create a Google Cloud OAuth client ("Web application"), enable the Gmail API and Google Calendar API, add ${google.redirect_uri} as an authorised redirect URI, then set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env and restart.`,
      },
      browser: { ...browser, ilearn_url: integ.ilearn_url, banner_url: integ.banner_url },
      web_search: { enabled: Boolean(model.web_search), provider: 'Claude web search (server tool)', requires: 'Web search must be enabled for your Anthropic organisation in the Claude Console.' },
      push: { configured: Boolean(notif.ntfy_url) },
    };
  }

  function statusSummary() {
    const s = status();
    const parts = [];
    parts.push(s.google.connected ? `Gmail + Google Calendar connected (${s.google.email || 'account'})` : s.google.configured ? 'Gmail/Calendar NOT connected (Sultan can connect in Settings)' : 'Gmail/Calendar NOT set up (needs Google OAuth credentials)');
    parts.push(s.browser.installed ? `browser workflow available (${s.browser.headless ? 'headless — no sign-in hand-off' : 'visible window'})${s.browser.ilearn_url ? `, iLearn at ${s.browser.ilearn_url}` : ''}${s.browser.banner_url ? `, Banner at ${s.browser.banner_url}` : ', Banner URL not set'}` : 'browser workflow NOT available (Playwright not installed)');
    parts.push(s.web_search.enabled ? 'web search on' : 'web search off');
    parts.push(s.push.configured ? 'phone push configured' : 'phone push not configured (in-app notifications only)');
    return parts.join('; ');
  }

  return { status, statusSummary };
}
