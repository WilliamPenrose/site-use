export interface ErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string; // accessibility tree summary when ARIA matching fails, helps diagnose page state
  screenshotBase64?: string; // M3 enhancement, field reserved now
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
    super('BrowserDisconnected', message, context);
    this.name = 'BrowserDisconnected';
  }
}

export class SessionExpired extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('SessionExpired', message, context);
    this.name = 'SessionExpired';
  }
}

export class ElementNotFound extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('ElementNotFound', message, context);
    this.name = 'ElementNotFound';
  }
}
