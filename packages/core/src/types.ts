export interface SnapshotNode {
  uid: string;
  role: string;
  name: string;
  value?: string;
  children?: string[];
  focused?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  selected?: boolean;
  level?: number;
}

export interface Snapshot {
  idToNode: Map<string, SnapshotNode>;
}

export interface ScrollOptions {
  direction: 'up' | 'down';
  amount?: number;
}

export interface InterceptControl {
  cleanup: () => void;
  reset: () => void;
  hasPending: () => boolean;
}

export interface ThrottleConfig {
  minDelay: number;
  maxDelay: number;
  rateLimit?: {
    window: number;
    maxOps: number;
  };
}

export interface Primitives {
  navigate(url: string): Promise<void>;
  takeSnapshot(): Promise<Snapshot>;
  click(uid: string): Promise<void>;
  type(uid: string, text: string, options?: { delay?: number }): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(options: ScrollOptions): Promise<void>;
  scrollIntoView(uid: string): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(): Promise<string>;
  interceptRequestWithControl(
    urlPattern: string | RegExp,
    handler: (response: { url: string; status: number; body: string }) => void,
  ): Promise<InterceptControl>;
}
