// src/trace.ts — Lightweight request-level tracing for MCP tool calls.

export interface SpanData {
  name: string;
  startMs: number;
  endMs: number | null;
  status: 'ok' | 'error' | 'running';
  attrs: Record<string, string | number | boolean>;
  error?: string;
  children: SpanData[];
}

export interface TraceData {
  tool: string;
  startedAt: string;
  elapsedMs: number;
  status: 'ok' | 'error';
  root: SpanData;
}

export interface SpanHandle {
  set(key: string, value: string | number | boolean): void;
  span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}

class InternalSpan {
  readonly data: SpanData;
  private ended = false;
  private readonly t0: number;

  constructor(name: string, t0: number) {
    this.t0 = t0;
    this.data = {
      name,
      startMs: Date.now() - t0,
      endMs: null,
      status: 'running',
      attrs: {},
      children: [],
    };
  }

  readonly handle: SpanHandle = {
    set: (key, value) => {
      if (this.ended) return;
      this.data.attrs[key] = value;
    },
    span: <T>(name: string, fn: (span: SpanHandle) => Promise<T>) => {
      return this.runChild(name, fn);
    },
  };

  end(status: 'ok' | 'error', error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.data.status = status;
    this.data.endMs = Date.now() - this.t0;
    if (error !== undefined) this.data.error = error;
  }

  private async runChild<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const child = new InternalSpan(name, this.t0);
    this.data.children.push(child.data);
    try {
      const result = await fn(child.handle);
      child.end('ok');
      return result;
    } catch (err) {
      child.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

export class Trace {
  private readonly t0: number;
  private readonly root: InternalSpan;
  private readonly toolName: string;
  private readonly startedAt: string;

  constructor(tool: string) {
    this.toolName = tool;
    this.t0 = Date.now();
    this.startedAt = new Date(this.t0).toISOString();
    this.root = new InternalSpan('root', this.t0);
  }

  async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    const child = new InternalSpan(name, this.t0);
    this.root.data.children.push(child.data);
    try {
      const result = await fn(child.handle);
      child.end('ok');
      return result;
    } catch (err) {
      child.end('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  toJSON(): TraceData {
    const elapsedMs = Date.now() - this.t0;
    const hasError = this.root.data.children.some((c) => c.status === 'error');
    return {
      tool: this.toolName,
      startedAt: this.startedAt,
      elapsedMs,
      status: hasError ? 'error' : 'ok',
      root: {
        name: this.root.data.name,
        startMs: 0,
        endMs: elapsedMs,
        status: hasError ? 'error' : 'ok',
        attrs: this.root.data.attrs,
        error: this.root.data.error,
        children: this.root.data.children,
      },
    };
  }
}

export const NOOP_SPAN: SpanHandle = {
  set() {},
  async span<T>(_name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
};

export const NOOP_TRACE: Trace = {
  async span<T>(_name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
  toJSON(): TraceData {
    return {
      tool: '',
      startedAt: '',
      elapsedMs: 0,
      status: 'ok',
      root: { name: '', startMs: 0, endMs: 0, status: 'ok', attrs: {}, children: [] },
    };
  },
} as Trace;
