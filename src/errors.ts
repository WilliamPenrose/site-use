export {
  BrowserDisconnected,
  BrowserNotRunning,
  SiteUseError,
} from '@site-use/runtime';
export type { ErrorContext } from '@site-use/runtime';

import { SiteUseError, type ErrorContext } from '@site-use/runtime';

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

export class CdpThrottled extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('CdpThrottled', message, {
      retryable: true,
      hint: 'Browser window may be in background or minimized. Bring it to the foreground, or restart Chrome.',
      ...context,
    });
    this.name = 'CdpThrottled';
  }
}

export class UserNotFound extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('UserNotFound', message, {
      retryable: false,
      hint: 'The user does not exist or the account has been suspended/deactivated.',
      ...context,
    });
    this.name = 'UserNotFound';
  }
}

export class DailyLimitExceeded extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('DailyLimitExceeded', message, {
      retryable: false,
      hint: 'Daily operation limit reached. Wait until tomorrow to continue.',
      ...context,
    });
    this.name = 'DailyLimitExceeded';
  }
}
