export interface ErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string;
  screenshotBase64?: string;
  retryable?: boolean;
  hint?: string;
  /** Structured diagnostic data from the operation that failed. */
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

export class SessionExpired extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('SessionExpired', message, {
      retryable: false,
      hint: 'Ask the user to log in manually in the Chrome window, then retry.',
      ...context,
    });
    this.name = 'SessionExpired';
  }
}

export class ElementNotFound extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('ElementNotFound', message, {
      retryable: true,
      hint: 'The page may still be loading. Try taking a screenshot to check page state, then retry.',
      ...context,
    });
    this.name = 'ElementNotFound';
  }
}

export class RateLimited extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('RateLimited', message, {
      retryable: false,
      hint: 'Rate limit detected. Wait before retrying.',
      ...context,
    });
    this.name = 'RateLimited';
  }
}

export class NavigationFailed extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('NavigationFailed', message, {
      retryable: true,
      hint: 'Network error or timeout. Wait a few seconds and retry.',
      ...context,
    });
    this.name = 'NavigationFailed';
  }
}

export class StateTransitionFailed extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('StateTransitionFailed', message, {
      retryable: true,
      hint: 'Element was found and clicked but did not reach the target state. The page may be unresponsive.',
      ...context,
    });
    this.name = 'StateTransitionFailed';
  }
}

export class BrowserNotRunning extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('BrowserNotRunning', message, {
      retryable: false,
      hint: "Run 'npx site-use browser launch' to start Chrome first.",
      ...context,
    });
    this.name = 'BrowserNotRunning';
  }
}
