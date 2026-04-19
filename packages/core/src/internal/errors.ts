export interface ErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string;
  screenshotBase64?: string;
  retryable?: boolean;
  hint?: string;
  diagnostics?: unknown;
}

export class SiteUseCoreError extends Error {
  readonly type: string;
  readonly context: ErrorContext;

  constructor(type: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'SiteUseCoreError';
    this.type = type;
    this.context = context;
  }
}

export class ElementNotFound extends SiteUseCoreError {
  constructor(message: string, context: ErrorContext = {}) {
    super('ElementNotFound', message, context);
    this.name = 'ElementNotFound';
  }
}

export class NavigationFailed extends SiteUseCoreError {
  constructor(message: string, context: ErrorContext = {}) {
    super('NavigationFailed', message, context);
    this.name = 'NavigationFailed';
  }
}

export class CdpThrottled extends SiteUseCoreError {
  constructor(message: string, context: ErrorContext = {}) {
    super('CdpThrottled', message, context);
    this.name = 'CdpThrottled';
  }
}
