# M3-06: 请求级 Trace — 框架层可观测性

> 日期：2026-03-28
> 状态：设计完成
> 归属：M3（可靠地长期运行 — 错误处理增强）

## 问题

MCP 工具调用失败时，错误信息只有一句话（如 "Input.dispatchMouseEvent timed out"），无法定位：

- 失败发生在 workflow 的哪一步
- 当时页面什么状态
- 数据采集到了什么程度
- 前面各步耗时多少

现有的 `debug` 参数只在成功时可用，且各 workflow 各自为政——自定义数据结构、末尾一次性组装、新增 workflow 要从头设计。

## 设计目标

1. **失败时自动诊断** — 错误响应自带结构化执行轨迹 + 截图，无需二次查询
2. **成功时零噪音** — 默认不返回 trace，`debug: true` 时按需获取
3. **框架层机制** — 所有 site plugin 的所有 workflow 自动获得 trace 能力，site 只负责打 span
4. **轻量级** — 不引入外部依赖，不需要 Collector/Exporter 基础设施

## 领域调研结论

调研了三个成熟的可观测性体系，各取所需：

| 来源 | 借鉴什么 | 不借鉴什么 |
|------|---------|-----------|
| **OpenTelemetry** | Span 树结构（name/start/end/status/attributes/children） | SDK/Exporter/Collector、跨进程传播、采样策略 |
| **Sentry Breadcrumbs** | "Always collect, send on error" 触发策略 | 环形缓冲区（低频调用不需要）、上报服务 |
| **Playwright Trace** | 失败时自动截图 | 全量 DOM 快照、trace ZIP 包、screencast |

### 场景特征（决定了取舍）

- **单进程、低频调用** — 不需要跨服务传播、采样策略、AsyncLocalStorage
- **调用链浅但步骤多** — Span 树比扁平 breadcrumb 列表更适合表达层级
- **失败原因高度视觉化** — 截图一看便知，文字日志表达力弱
- **调用方是 AI agent** — MCP 原生 image content block 比 JSON 内嵌 base64 更自然

### 覆盖范围

Trace 覆盖所有经过 `wrapToolHandler` 的 site plugin 工具（feed、check_login、customWorkflows）。

**不覆盖全局工具**（screenshot、search）——它们在 `server-global-tools.ts` 中直接注册到 McpServer，不走 wrapToolHandler。这些工具是单步操作或纯数据库查询，trace 没有诊断价值。

### 不做的事

- 不做持久化（不写文件、不存数据库）
- 不做跨请求缓存（trace 生命周期 = 单次请求）
- 不做 AsyncLocalStorage 隐式传播（workflow 调用链浅，参数显式传递更简单透明）
- 不做 CDP 级别的浏览器 trace（粒度太细、数据量太大）

---

## 数据模型

### Span

```typescript
interface SpanData {
  name: string;            // 操作名，如 'ensureTimeline', 'scrollRound_0'
  startMs: number;         // 相对于 trace 起点的毫秒偏移
  endMs: number | null;    // null = 仍在执行中（toJSON 时未结束的 span）
  status: 'ok' | 'error' | 'running';
  attrs: Record<string, string | number | boolean>;
  error?: string;          // status=error 时的错误信息
  children: SpanData[];
}
```

### Trace

```typescript
interface TraceData {
  tool: string;            // MCP 工具名，如 'twitter_feed'
  startedAt: string;       // ISO 时间戳（绝对时间，便于关联日志）
  elapsedMs: number;       // 总耗时
  status: 'ok' | 'error';
  root: SpanData;          // 顶层 span = workflow 本身
}
```

### 设计决策

1. **相对时间（startMs/endMs）** — trace 内部关注步骤间时序关系，相对偏移更直观。绝对时间只在 trace 根节点记一次（`startedAt`）
2. **三值 status（ok/error/running）** — 不采用 OTel 的 UNSET/OK/ERROR，因为我们的场景里 span 要么完成了要么没完成，不存在"没意见"的中间态
3. **attrs 用 Record** — 不同 workflow 步骤需要记录的信息不同，自由 kv 最灵活
4. **screenshot 不在数据模型中** — 截图通过 MCP image content block 返回，不嵌入 trace JSON

---

## Trace 类 API

文件位置：`src/trace.ts`

### 公开接口

```typescript
class Trace {
  constructor(tool: string);

  // 包裹异步操作，自动管理 span 生命周期
  async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T>;

  // 导出为 JSON
  toJSON(): TraceData;
}

interface SpanHandle {
  // 设置属性（可多次调用，同 key 覆盖）
  // span end 后调用 set() 静默忽略（不报错也不记录）
  set(key: string, value: string | number | boolean): void;

  // 在当前 span 下创建子 span
  span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T>;
}
```

### NOOP_TRACE / NOOP_SPAN

提供空操作常量，使 workflow 可以无条件调用 trace API 而不需要判空：

```typescript
export const NOOP_SPAN: SpanHandle = {
  set() {},
  async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
};

export const NOOP_TRACE: Trace = {
  async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
    return fn(NOOP_SPAN);
  },
  toJSON(): TraceData { return { tool: '', startedAt: '', elapsedMs: 0, status: 'ok', root: { name: '', startMs: 0, endMs: 0, status: 'ok', attrs: {}, children: [] } }; }
};
```

workflow 签名使用默认值，调用方不传 trace 时自动走空操作：

```typescript
export async function getFeed(primitives, opts, trace: Trace = NOOP_TRACE) {
  // 直接用，不需要判空
  await trace.span('ensureTimeline', async (s) => { ... });
}
```

同理，接收 SpanHandle 的辅助函数：

```typescript
export async function ensureTimeline(primitives, collector, opts, span: SpanHandle = NOOP_SPAN) {
  await span.span('navigate', async () => { ... });
}
```

### span() 的自动生命周期

```typescript
async span<T>(name: string, fn: (span: SpanHandle) => Promise<T>): Promise<T> {
  const span = this.beginSpan(name);
  try {
    const result = await fn(span.handle);
    span.end('ok');
    return result;
  } catch (err) {
    span.end('error', err.message);
    throw err;  // 继续冒泡，不吞异常
  }
}
```

保证：
- 正常完成 → `status: 'ok'`, `endMs` 有值
- 抛异常 → `status: 'error'`, `endMs` 有值, `error` 有信息
- 异常继续冒泡 → 外层 span 也会被标记 error

### 嵌套支持

`SpanHandle` 上也有 `span()` 方法，支持 workflow 内部及辅助函数的层级记录：

```typescript
// getFeed 传 SpanHandle 给 ensureTimeline
await trace.span('ensureTimeline', async (s) => {
  return await ensureTimeline(primitives, collector, { tab, t0 }, s);
});

// ensureTimeline 内部打细粒度 span
export async function ensureTimeline(
  primitives, collector, opts,
  span: SpanHandle = NOOP_SPAN,
) {
  await span.span('navigate', async () => {
    await primitives.navigate(TWITTER_HOME);
  });
  await span.span('switchTab', async (s) => {
    const { action } = await ensure({ role: 'tab', name: tabName, selected: true });
    s.set('action', action);
  });
  await span.span('waitForData', async (s) => {
    const satisfied = await collector.waitUntil(predicate, timeout);
    s.set('satisfied', satisfied);
    s.set('dataCount', collector.length);
  });
}
```

### 闭包内使用 SpanHandle

`span.set()` 可在 span 生命周期内从闭包调用，不限于 fn 的同步执行路径。典型场景是 interceptRequest 回调：

```typescript
await trace.span('getFeed', async (rootSpan) => {
  let graphqlCount = 0;

  const cleanup = await primitives.interceptRequest(pattern, (response) => {
    // rootSpan 被闭包捕获，回调里直接用
    rootSpan.set('graphqlResponses', ++graphqlCount);
  });

  await rootSpan.span('ensureTimeline', async (s) => { ... });
  await rootSpan.span('collectData', async (s) => { ... });

  cleanup();
  // rootSpan 在这行之后才结束，回调中的 set() 时序安全
});
```

### 内部实现要点

- **当前 span 追踪**：内部维护 `currentSpan` 指针，`span()` 调用时 push 子节点，结束时 pop。workflow 是线性执行的，没有并发 span，不需要 AsyncLocalStorage
- **时间基准**：构造时记录 `t0 = Date.now()`，所有 startMs/endMs 是相对 t0 的偏移
- **end 后静默**：span end 后，`set()` 调用静默忽略，防止异步回调在 span 结束后意外写入
- **零依赖**：纯 TypeScript，只用 `Date.now()`

---

## Plugin 契约变更

### registry/types.ts

`FeedCapability.collect` 和 `WorkflowDeclaration.execute` 新增可选 `trace` 参数：

```typescript
// FeedCapability
collect: (primitives: Primitives, params: unknown, trace?: Trace) => Promise<FeedResult>;

// WorkflowDeclaration
execute: (primitives: Primitives, params: unknown, trace?: Trace) => Promise<unknown>;
```

`AuthCapability.check` 和 `AuthCapability.guard` **不加** trace——登录检测是单步操作，没有多步 workflow。

trace 设为可选，理由：
- 简单 workflow 不需要打 span，强制接收没意义
- 框架层始终创建 trace，即使 workflow 不打 span，失败时仍有 root span 的时间信息和截图
- 未来新 plugin 可以渐进式采用

**契约 vs 实现的写法区分**：契约接口用 `trace?: Trace`（可选参数），workflow 实现用 `trace: Trace = NOOP_TRACE`（默认值）。两者在 TypeScript 里调用侧语义相同（都可以不传），但实现侧用默认值可以直接 `trace.span(...)` 无需判空。这是有意的区分。

### WrapOptions.handler

```typescript
// tool-wrapper.ts
handler: (params: Record<string, unknown>, runtime: SiteRuntime, trace?: Trace) => Promise<unknown>;
```

### codegen.ts 中间层透传

codegen.ts 的 handler 闭包是 wrapToolHandler 和 workflow 之间的中间层（负责 fetchTime 记录等）。trace 需要穿过这层：

```typescript
// codegen.ts — feed handler 闭包
handler: async (params, runtime, trace) => {
  const result = await feedCollect(runtime.primitives, params, trace);
  setLastFetchTime(...);
  return result;
},

// codegen.ts — customWorkflow handler 闭包
handler: async (params, runtime, trace) => {
  return await wf.execute(runtime.primitives, params, trace);
},
```

---

## 框架层注入：wrapToolHandler

wrapToolHandler 是 trace 的创建点和消费点。

### 与现有 formatError 的关系

现有 `formatError` 函数已在错误时自动截图（`context.screenshotBase64`）。改造后：

- **从 formatError 中删除截图逻辑** — 截图统一到 wrapToolHandler 层，用 MCP image content block 返回
- **formatError 的其他职责不变** — circuit breaker 记录、hint 解析、BrowserDisconnected 回调、错误分类

### 与 circuitBreaker 的关系

trace 机制与 circuitBreaker 完全正交：trace 的创建、span 记录、toJSON() 都是纯内存操作，不触及 circuitBreaker。circuitBreaker 的 `recordSuccess()`/`recordError()` 在 trace 注入前后均不受影响。

### formatError 改造

给 `formatError` 新增可选 `trace` 参数，在构造错误 JSON 时直接包含 trace 数据：

```typescript
async function formatError(
  siteName: string,
  err: Error,
  runtime: SiteRuntime | undefined,
  onBrowserDisconnected?: () => void,
  trace?: TraceData,  // 新增
): Promise<ToolResult> {
  // ... 现有逻辑（circuit breaker、hints、BrowserDisconnected 回调）不变 ...
  // 删除 context.screenshotBase64 截图逻辑

  const payload = { type: err.type, message: err.message, site: siteName, context };
  if (trace) payload.trace = trace;

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}
```

三个调用点：
- `getRuntime()` 失败 — 没有 trace，不传
- circuitBreaker 熔断 — 没有 trace，不传
- handler 执行失败 — 传 `trace.toJSON()`

### 伪代码

```typescript
// wrapToolHandler 核心流程（简化，省略 circuit breaker / mutex / validation 等已有逻辑）
const trace = new Trace(toolName);

try {
  const result = await opts.handler(rawParams, runtime, trace);

  if (rawParams.debug) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ result, trace: trace.toJSON() }) }
      ]
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }]
  };

} catch (err) {
  // formatError 处理错误分类、circuit breaker、hints，并包含 trace
  const errorResult = await formatError(siteName, err, runtime, onBrowserDisconnected, trace.toJSON());

  // 截图作为独立 MCP image content block
  // primitives 可能不可用（如 browser crash），或截图本身超时
  // 任何异常都吞掉——诊断代码不能引发二次故障
  try {
    if (runtime?.primitives?.screenshot) {
      const screenshot = await runtime.primitives.screenshot();
      errorResult.content.push({ type: 'image', data: screenshot, mimeType: 'image/png' });
    }
  } catch {
    // 跳过
  }

  return errorResult;
}
```

### CLI 兼容性

CLI 路径（`generateCliCommands`）也经过 wrapToolHandler，但不需要额外适配：

- **成功 + debug**：CLI 端直接打印 `content[0].text`，JSON 结构变了但不会报错（debug 是开发者工具）
- **失败**：CLI 端只读 `content[0]`（text block），image block 被自然忽略。trace 信息随 error JSON 一起打印，截图在终端里丢弃

---

## MCP 响应格式

### 成功 + `debug: false`（最常见，零变化）

```json
{
  "content": [
    { "type": "text", "text": "{\"items\":[...],\"meta\":{...}}" }
  ]
}
```

### 成功 + `debug: true`

```json
{
  "content": [
    { "type": "text", "text": "{\"result\":{\"items\":[...],\"meta\":{...}},\"trace\":{\"tool\":\"twitter_feed\",\"root\":{...}}}" }
  ]
}
```

### 失败（不管 debug 参数）

沿用 formatError 的现有结构，trace 作为顶层字段追加：

```json
{
  "content": [
    { "type": "text", "text": "{\"type\":\"PluginError\",\"message\":\"...\",\"site\":\"twitter\",\"context\":{...},\"trace\":{\"tool\":\"...\",\"root\":{...}}}" },
    { "type": "image", "data": "iVBORw0KGgo...", "mimeType": "image/png" }
  ],
  "isError": true
}
```

### 截图策略

| 场景 | 截图行为 |
|------|---------|
| 失败 | 自动截图，作为独立 image content block |
| 成功 + `debug: true` | 不截图 |
| 成功 + `debug: false` | 不截图 |
| 截图本身失败 | try/catch 吞掉，trace 返回但无截图 |

---

## Site 层改造

### workflow 函数签名

```typescript
// 改造前
export async function getFeed(primitives: Primitives, opts: GetFeedOptions): Promise<FeedResult>

// 改造后（使用默认值，不需要判空）
export async function getFeed(primitives: Primitives, opts: GetFeedOptions, trace: Trace = NOOP_TRACE): Promise<FeedResult>
```

辅助函数接收 SpanHandle：

```typescript
// 改造前
export async function ensureTimeline(primitives, collector, opts): Promise<EnsureTimelineResult>

// 改造后
export async function ensureTimeline(primitives, collector, opts, span: SpanHandle = NOOP_SPAN): Promise<EnsureTimelineResult>
```

### 改造前后对比（getFeed 核心段落）

```typescript
// ---- 改造前 ----
let graphqlResponseCount = 0;
let graphqlParseFailures = 0;
const notifyTimestamps: number[] = [];

const cleanup = interceptRequest(pattern, (resp) => {
  graphqlResponseCount++;
  notifyTimestamps.push(Date.now() - t0);
});

const ensureResult = await ensureTimeline(primitives, collector, { tab, t0 });
const collectResult = await collectData(primitives, collector, { count, t0 });

if (debug) {
  frameworkResult.debug = {
    tabRequested: tab,
    graphqlResponseCount,
    graphqlParseFailures,
    notifyTimestamps,
    elapsedMs: Date.now() - t0,
    ensureTimeline: ensureResult,
    collectData: collectResult,
  };
}

// ---- 改造后 ----
await trace.span('getFeed', async (rootSpan) => {
  rootSpan.set('tab', tab);
  let graphqlCount = 0;

  const cleanup = await primitives.interceptRequest(pattern, (resp) => {
    rootSpan.set('graphqlResponses', ++graphqlCount);
  });

  try {
    // SpanHandle 传入辅助函数，内部打细粒度 span
    await rootSpan.span('ensureTimeline', async (s) => {
      await ensureTimeline(primitives, collector, { tab, t0 }, s);
    });

    await rootSpan.span('collectData', async (s) => {
      await collectData(primitives, collector, { count, t0 }, s);
    });
  } finally {
    cleanup();
  }
});
// 不需要 if (debug) 了——trace 始终记录，框架层决定是否返回
```

### debug 信息迁移映射

| 现有 debug 字段 | 迁移到 |
|---|---|
| `tabRequested` | root span attr `tab` |
| `graphqlResponseCount` | root span attr `graphqlResponses` |
| `graphqlParseFailures` | root span attr `graphqlFailures` |
| `notifyTimestamps` | 每次 GraphQL 响应的 span 时间戳自然体现 |
| `ensureTimeline.navAction` | `ensureTimeline` span attr |
| `ensureTimeline.waits` | `ensureTimeline` 下的子 span |
| `collectData.scrollRounds` | `collectData` span attr |
| `collectData.waits` | 每轮 scroll 一个子 span |
| `elapsedMs` | trace 级别 `elapsedMs` |

### types.ts 清理

- 删除 `FeedDebug` 接口
- 删除 `FeedResult.debug?` 字段
- 删除 `TweetDetailResult.debug?` 字段
- 删除 `registry/types.ts` 中的 `debug?: Record<string, unknown>`

### 后续清理（实现完成且测试通过后）

span 接管诊断职责后，以下专为 debug 输出设计的类型可以简化：

- 删除 `WaitRecord` 接口（其信息由 span attrs 承载）
- `EnsureTimelineResult` 去掉 `waits` 字段（只保留 `navAction`、`tabAction`、`reloaded`）
- `CollectDataResult` 去掉 `waits` 字段（只保留 `scrollRounds`）
- 删除 `timedWait` 辅助函数（其逻辑被 span 替代）

---

## 改动范围

### 改什么

| 文件 | 改动 |
|------|------|
| `src/trace.ts`（新增） | Trace 类、SpanHandle、NOOP_TRACE、NOOP_SPAN、TraceData/SpanData 类型 |
| `src/registry/types.ts` | `FeedCapability.collect` 和 `WorkflowDeclaration.execute` 新增 `trace?: Trace` 参数；删除 `FeedResult.debug?` 字段 |
| `src/registry/tool-wrapper.ts` | `WrapOptions.handler` 新增 `trace` 参数；创建 Trace 注入到 handler；catch 里通过 `formatError` 的新 `trace` 参数附带 trace；从 `formatError` 删除截图逻辑，改为 wrapToolHandler 层 image block 截图 |
| `src/registry/codegen.ts` | handler 闭包透传 trace 到 workflow；`FeedResultSchema` 删除 `debug` 字段 |
| `src/sites/twitter/workflows.ts` | getFeed、getTweetDetail 新增 `trace` 参数（默认 NOOP_TRACE）；ensureTimeline、collectData 新增 `span` 参数（默认 NOOP_SPAN）；关键步骤用 `span()` 包裹；删除末尾 debug 组装 |
| `src/sites/twitter/types.ts` | 删除 `FeedDebug` 接口及 debug 字段 |
| `src/sites/twitter/__tests__/workflows.test.ts` | 更新 debug 断言为 trace span 树结构 |

### 不改什么

- MCP tool schema 不变（`debug` 参数对外定义不变）
- 成功时非 debug 模式的响应格式不变
- Site plugin 注册机制不变
- Primitives 层不变
- `debug` 参数语义不变（控制成功时是否返回诊断信息）
- 全局工具（screenshot、search）不变
- circuitBreaker 逻辑不变
- CLI 路径不需要额外适配

---

## 输出示例（失败场景）

以下是 `content[0].text` 反序列化后的 JSON（沿用 formatError 现有结构 + trace 字段）：

```json
{
  "type": "PluginError",
  "message": "Plugin \"twitter\" threw an unexpected error: Input.dispatchMouseEvent timed out",
  "site": "twitter",
  "context": {
    "originalError": "Input.dispatchMouseEvent timed out",
    "retryable": false
  },
  "trace": {
    "tool": "twitter_tweet_detail",
    "startedAt": "2026-03-28T12:30:00.000Z",
    "elapsedMs": 16200,
    "status": "error",
    "root": {
      "name": "getTweetDetail",
      "startMs": 0,
      "endMs": 16200,
      "status": "error",
      "attrs": { "url": "https://x.com/steipete/status/2037725493315707290" },
      "error": "Input.dispatchMouseEvent timed out",
      "children": [
        {
          "name": "ensureTweetDetail",
          "startMs": 50,
          "endMs": 1200,
          "status": "ok",
          "attrs": { "reloaded": false },
          "children": [
            { "name": "navigate", "startMs": 50, "endMs": 300, "status": "ok", "attrs": {}, "children": [] },
            { "name": "switchTab", "startMs": 300, "endMs": 800, "status": "ok", "attrs": { "action": "transitioned" }, "children": [] },
            { "name": "waitForData", "startMs": 800, "endMs": 1200, "status": "ok", "attrs": { "satisfied": true, "dataCount": 5 }, "children": [] }
          ]
        },
        {
          "name": "clickTweet",
          "startMs": 1200,
          "endMs": 16200,
          "status": "error",
          "error": "Input.dispatchMouseEvent timed out",
          "attrs": {},
          "children": []
        }
      ]
    }
  }
}
```

`content[1]` 是 image content block（截图），此处省略。

一眼定位：`ensureTweetDetail` 内部三步（navigate → switchTab → waitForData）全部成功，死在 `clickTweet` 步骤（耗尽 15 秒超时）。配合截图即可判断页面状态。
