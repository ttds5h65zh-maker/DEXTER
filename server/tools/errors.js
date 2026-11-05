// Errors tools can throw to change how the agent loop proceeds.

/** The tool cannot continue until Sultan does something (sign in, MFA, answer a prompt). */
export class NeedsUserError extends Error {
  constructor({ kind = 'browser_signin', title, message, url = null, screenshot_file_id = null }) {
    super(message);
    this.kind = kind;
    this.title = title;
    this.url = url;
    this.screenshot_file_id = screenshot_file_id;
  }
}

/** An integration is not connected; message includes setup instructions. */
export class NotConnectedError extends Error {
  constructor(integration, message) {
    super(message);
    this.integration = integration;
    this.code = 'not_connected';
  }
}

/** A tool refused the input (bad arguments, failed precondition). */
export class ToolInputError extends Error {}
