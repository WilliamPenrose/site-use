export interface ErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string;
  screenshotBase64?: string;
  retryable?: boolean;
  hint?: string;
  diagnostics?: unknown;
}

export class SiteUseError extends Error {
  readonly type: string;
  readonly context: ErrorContext;

  constructor(type: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'SiteUseError';
    this.type = type;
    this.context = context;
  }
}

export class BrowserDisconnected extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('BrowserDisconnected', message, {
      retryable: true,
      hint: 'Chrome has closed. The next tool call will automatically relaunch it.',
      ...context,
    });
    this.name = 'BrowserDisconnected';
  }
}

export class BrowserNotRunning extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('BrowserNotRunning', message, {
      retryable: false,
      hint: "Run 'site-use browser launch' to start Chrome first.",
      ...context,
    });
    this.name = 'BrowserNotRunning';
  }
}
