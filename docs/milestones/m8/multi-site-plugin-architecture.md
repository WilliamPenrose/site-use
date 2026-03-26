# M8: 多 Site 插件架构

> 日期：2026-03-26
> 状态：设计中
> 上游文档：[里程碑总览](../overview.md)、[技术架构设计](../../site-use-design.md)

## 目标

将 site-use 从单 site（Twitter）工具转变为通用多 site 框架——任何 site 均可插件化接入（内置或外部），具备完整的运行时隔离、自动 MCP/CLI 生成和独立测试能力。

---

## 0. 改造前后对比

| 维度 | 改造前（当前） | 改造后（M8） |
|------|--------------|-------------|
| **Site 数量** | 仅 Twitter，硬编码 | 任意数量，可插拔 |
| **插件形态** | 无插件概念；`server.ts` 直接 import Twitter workflows | 声明式 `SitePlugin` 对象；内置 + 外部 npm 包 |
| **MCP Tool 注册** | `server.ts` 手写每个 tool 的 registration | 框架从 `SitePlugin` 声明自动生成 |
| **CLI 命令** | `cli/workflow.ts` 硬编码 `twitter feed` | 框架从 `SitePlugin` 声明自动生成 `{site} {command}` |
| **Primitives 栈** | 全局单一 `PrimitivesStack` | `Map<string, SiteRuntime>`，per-site 独立栈 |
| **Tab 管理** | 所有操作共享一个 tab | 每个 site 独立 tab |
| **Mutex** | 全局 mutex，所有操作串行 | per-site mutex，跨 site 可并行 |
| **Rate Limiter** | 全局单一（仅 Twitter 策略） | per-site 独立，各 site 策略不同 |
| **Circuit Breaker** | 全局单一，一个 site 挂全挂 | per-site 独立，故障不扩散 |
| **Auth 状态** | 全局单一 | per-site 独立登录状态 |
| **错误信息** | 无 `site` 字段；hint 硬编码 | 错误携带 `site` 字段；hint 由插件声明 + 框架默认 |
| **存储** | `store.ingest()` 在 workflow 内直接调用 | 框架在 `feed.collect()` 后自动调用 `storeAdapter` → `ingest` |
| **测试组织** | `tests/unit/twitter-*.test.ts` | `src/sites/twitter/__tests__/*.test.ts`（co-located） |
| **测试工具** | mock helpers 散落在测试文件中 | 框架导出 `site-use/testing` 公开 test kit |
| **插件契约测试** | 无 | `tests/contract/plugin-contract.test.ts` 验证框架承诺 |
| **server.ts 职责** | 大函数：import + build stack + register tools + error handling | 薄编排层：调用 Registry + Runtime，约 30 行 |
| **新增 site 所需工作** | 改 `server.ts`、改 `cli/workflow.ts`、改 `primitives/factory.ts` | 只写 `src/sites/<name>/index.ts` 导出 `SitePlugin` |
| **外部扩展** | 不可能 | 发 npm 包 + 配置文件一行声明 |
| **公开 API** | 无 | `site-use`（类型）、`site-use/ops`（工具）、`site-use/testing`（测试） |

### MCP Tools 前后对比

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| **注册方式** | `server.ts` 中手写 `server.registerTool('twitter_check_login', ...)` | 框架遍历 `SitePlugin.capabilities` + `customWorkflows`，自动调用 `registerTool` |
| **Tool 命名** | 手动起名，无统一规范 | 强制 `{site}_{capability}` / `{site}_{workflow}` 模式 |
| **Tool 描述** | 硬编码在 `server.ts` 的 schema 对象中 | 插件声明 `description` 字段；标准能力有框架默认描述可兜底 |
| **参数 Schema** | 手写 JSON Schema 嵌入 tool definition | 插件用 Zod 定义，框架自动转换为 JSON Schema |
| **Tool handler** | 手写：获取 primitives → 调用 workflow → 格式化结果 → 错误处理 | 框架统一生成 handler：懒 runtime → mutex → Zod 校验 → workflow → 错误包装 → 截图 → 熔断 |
| **暴露控制** | 无——注册即暴露 | `expose` 字段控制是否暴露到 MCP、CLI 或两者 |
| **添加新 site 的 tool** | 改 `server.ts`：加 import、加 registerTool、加 handler 逻辑 | 只写 `SitePlugin` 声明，零框架代码改动 |
| **全局 tool** | `screenshot`、`search`、`stats` 与 site tool 混在一起注册 | 全局 tool 独立注册（`registerGlobalTools`），与 site tool 分离 |
| **Tool 列表** | 启动时固定 5 个 | 启动时根据已发现插件动态生成 |

### CLI 命令前后对比

| 维度 | 改造前 | 改造后 |
|------|--------|--------|
| **命令结构** | 扁平：`site-use twitter feed`、`site-use search`、`site-use stats` | 层级化：`site-use {site} {command}`（site 命令）+ `site-use {global}`（全局命令） |
| **命令注册** | `index.ts` 手写 `program.command('twitter').command('feed')` | 框架遍历插件声明自动注册子命令 |
| **参数/Flag** | 手写 `.option('--count', ...)` | 从 Zod schema 自动推导；`cli` 字段可手动覆盖 |
| **Help 文本** | 手写 `.description()`，详略不一 | 插件声明 `cli.help`、`cli.examples`；标准能力有框架默认帮助 |
| **添加新 site 的命令** | 改 `index.ts`：加 import、加 command 定义、加 action handler | 只写 `SitePlugin` 声明，零框架代码改动 |
| **暴露控制** | 无——写了就有 | `expose` 字段控制；`expose: ['mcp']` 的 workflow 不生成 CLI 命令 |

### 向后兼容性

M8 改造对现有用户和 AI agent 完全向后兼容——不改名、不改参数、不删功能。

**MCP Tools：仅 Twitter 时 agent 看到的 tool 列表不变：**

| 当前 | M8 后（仅 Twitter） | 变化 |
|------|---------------------|------|
| `twitter_check_login` | `twitter_check_login` | 无 |
| `twitter_feed` | `twitter_feed` | 无 |
| `screenshot` | `screenshot` | 无 |
| `search` | `search` | 无 |
| `stats` | `stats` | 无 |

多 site 时自然增长（如 `reddit_check_login`、`reddit_feed`、`xhs_feed` 等）。

**CLI：所有当前命令保持不变：**

| 当前命令 | M8 后 | 变化 |
|---------|-------|------|
| `site-use twitter feed` | `site-use twitter feed` | 无 |
| `site-use search` | `site-use search` | 无（全局） |
| `site-use stats` | `site-use stats` | 无（全局） |
| `site-use rebuild` | `site-use rebuild` | 无（全局） |
| `site-use clean` | `site-use clean` | 无（全局） |
| `site-use browser launch/status/close` | `site-use browser launch/status/close` | 无（全局） |
| `site-use diagnose` | `site-use diagnose` | 无（全局） |
| `site-use mcp` | `site-use mcp` | 无（全局） |

新增：`site-use twitter check-login`（当前 check-login 仅 MCP 暴露，CLI 未有）。多 site 时自然增长（如 `site-use reddit feed`、`site-use xhs check-login` 等）。

---

## 1. 插件契约（SitePlugin）

每个 site——无论内置还是外部——导出一个声明式对象，遵循 `SitePlugin` 接口。这是 site 与框架之间的唯一契约。

```ts
export interface SitePlugin {
  /** 插件 API 版本。当前为 1。框架据此做向后兼容。 */
  apiVersion: 1;

  /** 唯一标识符。用作 MCP tool 前缀和存储 key。
   *  不得与全局命令同名（保留名：browser、search、stats、rebuild、clean、diagnose、mcp、help）。 */
  name: string;

  /** 该 site 运行的域名。用于路由和登录保护。 */
  domains: string[];

  /** 针对该 site HTTP 响应的限速检测。 */
  detect?: DetectFn;

  /** 标准能力——框架自动生成 MCP tools + CLI 命令。 */
  capabilities?: {
    auth?: AuthCapability;
    feed?: FeedCapability;
    // 未来扩展：search、post、scrape……
  };

  /** Site 自定义 workflow——每个都会成为一个 MCP tool 和/或 CLI 命令。 */
  customWorkflows?: WorkflowDeclaration[];

  /** 将 site 领域模型转换为通用 IngestItem[] 以入库存储。 */
  storeAdapter?: StoreAdapter;

  /** 给 AI agent 的错误提示，按错误类型索引。 */
  hints?: SiteErrorHints;
}
```

### 1.1 标准能力（Standard Capabilities）

标准能力的**输出类型**由框架定义（确保跨 site 一致性），**输入参数**由插件自定义（各 site 差异太大无法统一）。

```ts
interface AuthCapability {
  check: (primitives: Primitives) => Promise<CheckLoginResult>;
  description?: string;   // 覆盖默认 MCP tool 描述
  expose?: ExposeTarget[]; // 默认 ['mcp', 'cli']
  cli?: CliConfig;
}

interface FeedCapability {
  collect: (primitives: Primitives, params: unknown) => Promise<FeedResult>;
  params: ZodSchema;       // 插件自定义入参（如 { count, tab } 或 { subreddit, sort }）
                           // 框架自动转换为 MCP 的 JSON Schema
  description?: string;
  expose?: ExposeTarget[];
  cli?: CliConfig;
}

type ExposeTarget = 'mcp' | 'cli';
```

> **为什么 feed 入参不统一？** Twitter 需要 `tab: 'for_you' | 'following'`，Reddit 需要 `subreddit` + `sort`，小红书需要 `category` + `noteType`——差异太大无法抽象。统一的是输出（`FeedResult`），不是输入。

**FeedResult 采用通用结构 + site 特有扩展：**

```ts
interface FeedResult {
  items: FeedItem[];
  meta: FeedMeta;
}

interface FeedItem {
  id: string;
  author: { handle: string; name: string };
  text: string;
  timestamp: string;
  url: string;
  media: MediaItem[];
  links: string[];
  /** site 特有字段（指标、分类等） */
  siteMeta: Record<string, unknown>;
}

interface FeedMeta {
  coveredUsers: string[];
  timeRange: { from: string; to: string };
}
```

共性字段（id、author、text、timestamp、media）统一，差异字段全部收进 `siteMeta`。Twitter 的 `siteMeta` 有 `retweets`、`surfaceReason`；Reddit 的有 `subreddit`、`upvotes`；小红书的有 `noteType`、`collectCount`。

> **Best Practice：siteMeta 构造时 Zod 校验。** `siteMeta` 是 `Record<string, unknown>`，`StoreAdapter` 中通过 `as` 断言转为 site 特有类型。为防止数据静默丢失（如上游 API schema 变化导致字段缺失），插件应在构造 FeedItem 时用 Zod schema 校验 siteMeta，确保数据在**产出时**即被验证，而非等到入库才发现问题：
>
> ```ts
> // Twitter 插件内部
> const TwitterSiteMetaSchema = z.object({
>   likes: z.number(),
>   retweets: z.number(),
>   surfaceReason: z.string(),
>   following: z.boolean(),
>   // ...
> });
>
> function tweetToFeedItem(tweet: Tweet): FeedItem {
>   const siteMeta = { likes: tweet.metrics.likes, ... };
>   TwitterSiteMetaSchema.parse(siteMeta);  // 构造时校验，不合法立即报错
>   return { id: tweet.id, ..., siteMeta };
> }
> ```
>
> 这比纯 TypeScript 类型检查更强：类型检查只防编译期错误，Zod 还防运行时数据异常。

### 1.2 自定义 Workflow

用于标准能力无法覆盖的 site 特有操作。

```ts
interface WorkflowDeclaration {
  name: string;
  description: string;            // MCP tool 描述——必填，框架无法猜测业务含义
  params: ZodSchema;
  execute: (primitives: Primitives, params: unknown) => Promise<unknown>;
  expose?: ExposeTarget[];        // 默认 ['mcp', 'cli']
  cli?: CliConfig;
}
```

### 1.3 CLI 配置

当 Zod schema 自动推导的 flag 不够用时，插件可声明显式 CLI 配置。

```ts
interface CliConfig {
  description: string;            // 一行帮助描述
  help: string;                   // 多行详细帮助文本
  examples?: string[];
  args?: CliArgDeclaration[];     // 位置参数
  flags?: CliFlagDeclaration[];   // 覆盖自动推导的 flag
}
```

默认行为：框架从 Zod schema 自动推导 CLI flags（字段名 → `--flag-name`，`.describe()` → flag 描述）。声明了 `cli` 字段时，以显式配置为准。

### 1.4 Store Adapter

```ts
interface StoreAdapter {
  toIngestItems: (items: FeedItem[]) => IngestItem[];
}
```

可选。只做实时操作的 site（如截图、状态检查）不需要存储。未声明时框架不执行 ingest，feed 结果仅返回给调用方。仅 feed 标准能力触发自动 ingest；自定义 workflow 不触发（未来可扩展）。

`IngestItem` 上的 `site` 字段由框架自动注入——插件无需设置。

### 1.5 错误提示（Error Hints）

```ts
interface SiteErrorHints {
  sessionExpired?: string;
  rateLimited?: string;
  elementNotFound?: string;
  navigationFailed?: string;
  stateTransitionFailed?: string;
}
```

抛出 per-site 错误时，框架查找该插件的 hint。未声明则使用框架默认值：

| 错误类型 | 默认 Hint |
|---------|-----------|
| `SessionExpired` | `"User is not logged in to {site}. Ask the user to log in manually in the browser, then retry."` |
| `RateLimited` | `"Rate limited by {site}. Do not retry immediately. Wait or switch to a different task, then retry later."` |
| `ElementNotFound` | `"Expected UI element not found on {site}. The page may not have loaded fully, or the site's UI may have changed. Try taking a screenshot to diagnose."` |
| `NavigationFailed` | `"Failed to navigate on {site}. Check if the site is accessible and the URL is correct. Try taking a screenshot to see the current page state."` |
| `StateTransitionFailed` | `"Action did not produce the expected result on {site}. Take a screenshot to see current state, then decide whether to retry or try an alternative approach."` |

模式：描述发生了什么 → 告诉 agent 不要做什么 → 建议下一步行动。`{site}` 由框架自动替换。

---

## 2. 插件发现与加载

### 2.1 插件来源

| 优先级 | 来源 | 路径 |
|--------|------|------|
| 1 | 配置文件 | `~/.site-use/config.json` → `plugins` 数组 |
| 2 | 内置插件 | `src/sites/*/index.ts`，随主包发布 |

外部插件覆盖同名内置插件（允许用户 fork 内置 site 做定制）。

### 2.2 配置文件

```jsonc
// ~/.site-use/config.json
{
  "plugins": [
    "@site-use/plugin-reddit",   // npm 包，通过 import() 解析
    "./my-local-plugin"          // 本地路径，开发用
  ]
}
```

### 2.3 加载流程

1. **启动——导入并校验**：扫描内置 `src/sites/*/` 目录并读取配置文件。Import 每个插件模块以获取其 `SitePlugin` 对象。**用 Zod 校验 `SitePlugin` 结构**——校验失败则 fatal error 退出（前期严格，避免静默失败）。校验包括：结构合法性、`name` 不在保留名列表中、`name` 无重复、`domains` 非空。
2. **启动——注册 tools**：根据校验通过的插件声明生成 MCP tool 定义和 CLI 命令。**不创建任何运行时资源**（不开 tab、不初始化限速器、不启动 Chrome）。
3. **首次调用——懒创建运行时**：当某个 site 的 MCP tool 被调用时，创建该 site 的 `SiteRuntime`（开 tab、初始化限速器、熔断器等）。Chrome 在首次调用任意 site 时启动。

**保留名列表**（插件 `name` 不得使用）：`browser`、`search`、`stats`、`rebuild`、`clean`、`diagnose`、`mcp`、`help`。

**Domains 重叠**：允许多个插件声明相同的 domain。不同 site 可能共享域名（如一个处理 `reddit.com` 的 feed，另一个处理 `reddit.com` 的 profile）。auth guard 和 rate-limit detect 按首个匹配的 site 路由。

### 2.4 导出约定

内置和外部插件使用完全相同的导出约定：

```ts
// src/sites/twitter/index.ts（内置）
// 或：@site-use/plugin-reddit/src/index.ts（外部 npm 包）
export const plugin: SitePlugin = {
  name: 'twitter',
  domains: ['x.com', 'twitter.com'],
  capabilities: { ... },
  storeAdapter: { ... },
  detect: twitterDetect,
  hints: { ... },
};
```

内置与外部无结构差异，仅加载路径不同。

---

## 3. 运行时隔离

### 3.1 SiteRuntime

每个 site 拥有独立的运行时上下文，在首次 tool 调用时懒创建。

```ts
interface SiteRuntime {
  plugin: SitePlugin;
  primitives: Primitives;         // 独立的 primitives 栈
  page: Page;                     // 独立的 Chrome tab
  rateLimitDetector: RateLimitDetector; // 独立的限速检测器（可从外部查询状态）
  circuitBreaker: CircuitBreaker; // 独立的熔断器
  mutex: Mutex;                   // 独立的操作锁
  authState: AuthState;           // 独立的登录状态（M8 预留，不主动更新）
}
```

### 3.2 共享 vs. 隔离

**共享：Chrome 实例（Browser）。** 一个 Chrome 进程，多个 tab。

**Per-site 隔离：其他一切。**

```
┌──────────────────────────────────────────────────┐
│                Browser（共享）                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  │
│  │Tab: twitter │  │Tab: reddit │  │Tab: xhs    │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  │
└────────┼───────────────┼───────────────┼─────────┘
         │               │               │
   SiteRuntime     SiteRuntime     SiteRuntime
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │mutex     │    │mutex     │    │mutex     │
   │rateLimit │    │rateLimit │    │rateLimit │
   │circuit   │    │circuit   │    │circuit   │
   │authState │    │authState │    │authState │
   └──────────┘    └──────────┘    └──────────┘
```

### 3.3 关键行为

1. **懒创建**——SiteRuntime 在该 site 的首次 tool 调用时创建（开 tab、初始化限速器）。
2. **跨 site 并行**——不同 site 可并行操作（独立 mutex）。同一 site 内串行（单 tab 不能并发操作 DOM）。
3. **故障隔离**——熔断器 per-site 触发，采用三态模型（closed → open → half-open）。Twitter 连续 5 次错误触发熔断（进入 open），冷却期间（默认 60 秒）该 site 所有请求直接拒绝，不影响 Reddit。冷却结束后进入 half-open，允许一次试探性调用：成功则恢复 closed，失败则重回 open 再次冷却。
4. **浏览器断连恢复**——Chrome 断开时清空所有 SiteRuntime。下次任意 tool 调用重启 Chrome 并按需重建各 site 的 runtime。
5. **Tab 生命周期**——Tab 随 SiteRuntime 创建而打开。MCP server 关闭时不主动关 tab（Chrome 由用户管理，与当前行为一致）。

### 3.4 SiteRuntimeManager

所有 site runtime 的中心管理器：

```ts
class SiteRuntimeManager {
  private runtimes: Map<string, SiteRuntime>;
  private pending: Map<string, Promise<SiteRuntime>>; // 并发创建保护
  private browser: Browser | null;

  /** 获取或创建某 site 的 runtime（懒加载）。
   *  并发安全：同一 site 的多个并发 get() 共享同一个创建 Promise，
   *  不会重复开 tab。 */
  async get(siteName: string): Promise<SiteRuntime>;

  /** 清空所有 runtime（浏览器断连时）。 */
  clearAll(): void;

  /** 清空特定 site 的 runtime（site 级故障时）。 */
  clear(siteName: string): void;
}
```

`get()` 的并发保护逻辑：

```ts
async get(siteName: string): Promise<SiteRuntime> {
  const existing = this.runtimes.get(siteName);
  if (existing) return existing;

  // 如果已有正在创建的 Promise，等待它而非重复创建
  const inflight = this.pending.get(siteName);
  if (inflight) return inflight;

  const promise = this.createRuntime(siteName);
  this.pending.set(siteName, promise);
  try {
    return await promise;
  } finally {
    this.pending.delete(siteName);
  }
}
```

### 3.5 未来扩展：Per-Site 浏览器

不纳入 M8 范围，但设计已预留支持。未来可在 `SitePlugin` 上添加 `browser` 字段：

```ts
browser?: {
  mode: 'shared' | 'dedicated';
  headless?: boolean;
};
```

`SiteRuntime` 持有的是 `Page` 而非 `Browser`——切换共享/独立浏览器只影响 `SiteRuntimeManager.get()` 逻辑，不影响插件。

---

## 4. MCP Tool 与 CLI 自动生成

### 4.1 MCP Tool 生成规则

**标准能力 → 固定命名模式：**

| 能力 | 生成的 MCP Tool | 默认描述 |
|------|----------------|---------|
| `auth` | `{site}_check_login` | `"Check if user is logged in to {site}"` |
| `feed` | `{site}_feed` | `"Collect feed items from {site}"` |

**自定义 workflow → 同样的命名模式：**

声明 `{ name: 'trending' }` → 生成 tool `{site}_trending`

**插件可通过 `description` 字段覆盖描述。** 默认描述仅作兜底。

### 4.2 框架提供的 Tool 包装

每个生成的 tool 调用都被框架包装，处理所有横切关注点：

```
MCP tool 调用
  → SiteRuntimeManager.get(site)     // 懒创建 runtime
  → 熔断器前置检查                      // 已熔断则直接拒绝，不入队
  → Zod 参数校验                       // mutex 外校验，不占锁时间
  → per-site mutex.run()              // 串行化
  →   插件 workflow 函数                // 业务逻辑
  →   Zod 校验返回值                    // 标准能力校验 FeedResult 等结构
  → 错误分类 + hint 注入               // SiteUseError 包装
  → 失败时自动截图                      // 诊断
  → 熔断器计数                          // 故障追踪
  → 结构化 JSON 响应                    // 输出格式化
```

> 熔断器检查和参数校验放在 mutex 之前是有意优化：已熔断的请求不应排队等锁，参数不合法的请求不应占用锁时间。

插件只写纯业务逻辑。所有运维关注点由框架处理。

### 4.3 CLI 生成规则

```
site-use {site} check-login          ← auth 能力
site-use {site} feed [options]       ← feed 能力
site-use {site} {workflow} [options] ← 自定义 workflow
```

**两层 flag 推导：**

1. **自动推导**：框架从 Zod schema 推导 CLI flags（字段名 → `--flag-name`，`.describe()` → flag 描述）。大多数场景足够。
2. **手动覆盖**：声明了 `cli` 字段时以其为准——自定义描述、帮助文本、示例、位置参数、flag 别名。

### 4.4 暴露控制

每个能力和 workflow 声明暴露目标：

```ts
expose?: ('mcp' | 'cli')[];  // 默认 ['mcp', 'cli']
```

- `['mcp']`——仅 MCP tool，无 CLI 命令
- `['cli']`——仅 CLI 命令，无 MCP tool
- `['mcp', 'cli']`——两者都有（默认）

### 4.5 跨 site 全局 Tools

以下 tool 不属于任何 site，保持不变：

| Tool | 说明 |
|------|------|
| `screenshot` | 截图（**必须指定 `site` 参数**以选择 tab；不指定则报错） |
| `search` | 全文搜索（跨 site 或按 site 过滤） |
| `stats` | 按 site 统计存储数据 |

### 4.6 动态 Tool 列表

启动时根据已发现的插件动态生成 tool 列表（仅读取声明，不创建运行时资源）。配置文件中添加新外部插件后，重启 MCP server 即可生效。

---

## 5. 错误处理

### 5.1 错误层级

在当前设计基础上增加 site 感知：

```
SiteUseError（基类）
├── BrowserDisconnected    ← 全局级，影响所有 site
├── BrowserNotRunning      ← 全局级
├── SessionExpired         ← per-site
├── ElementNotFound        ← per-site
├── RateLimited            ← per-site
├── NavigationFailed       ← per-site
├── StateTransitionFailed  ← per-site
└── (PluginError)          ← 非独立子类，用 SiteUseError('PluginError', ...) 构造
```

### 5.2 相对当前设计的变化

1. **所有 per-site 错误携带 `site` 字段**——agent 可识别是哪个 site 出错。
2. **熔断器 per-site 计数**——Twitter 连续 5 次错误触发熔断，不影响 Reddit。
3. **浏览器级错误重置所有 runtime**——`BrowserDisconnected` 清空整个 `SiteRuntimeManager`。
4. **PluginError 包装未知错误**——防止未分类错误绕过错误体系。

不创建独立的 `PluginError` 子类。框架用 `new SiteUseError('PluginError', message, context)` 构造，序列化为 JSON 时 `type` 字段为 `'PluginError'`。MCP 协议传输的是 JSON，agent 通过 `type` 字符串区分错误类型，不需要 `instanceof` 检查。

```ts
// 构造方式（在 tool-wrapper.ts 中）：
new SiteUseError('PluginError',
  `Plugin "${siteName}" threw an unexpected error: ${cause.message}`,
  { retryable: false, site: siteName, originalError: cause.message },
)
```

### 5.3 Hint 解析

抛出 per-site 错误时：
1. 查找 `plugin.hints[errorType]`
2. 有声明 → 使用插件提供的 hint
3. 未声明 → 使用框架默认值（见 1.5 节）

---

## 6. 存储集成

### 6.1 数据流

```
plugin.capabilities.feed.collect(primitives, params)
  → FeedResult { items: FeedItem[] }
  → plugin.storeAdapter.toIngestItems(items)    // 强类型：FeedItem[] → IngestItem[]
  → 框架注入 site 字段
  → Zod 校验 IngestItem[]
  → store.ingest(ingestItems)
```

仅 feed 标准能力触发此流程。自定义 workflow 不自动 ingest（未来可扩展 `persist` 标记）。

### 6.2 无 Schema 变更

当前 SQLite schema 已经是 site-aware 的（`posts.site` 字段）。无需结构变更。`IngestItem` 是插件和存储之间的稳定契约——运行时由 Zod 校验。

### 6.3 可选存储

未声明 `storeAdapter` 的插件完全跳过 ingest 步骤。Feed 结果返回给调用方但不持久化。

---

## 7. 测试架构

### 7.1 目录结构

```
src/sites/twitter/__tests__/       ← Twitter 插件测试（co-located）
src/sites/reddit/__tests__/        ← Reddit 插件测试（co-located）
tests/unit/                        ← 框架级 unit tests（primitives、browser、storage、errors）
tests/contract/                    ← MCP 协议 + 插件契约合规
tests/integration/                 ← 跨层集成
tests/e2e/                         ← 真实浏览器
```

### 7.2 框架 Test Kit

作为 `site-use/testing` 公开导出，内置和外部插件均可使用：

```ts
import { createMockPrimitives, buildSnapshot, createMockStore, assertIngestItems } from 'site-use/testing';
```

| 导出 | 用途 |
|------|------|
| `createMockPrimitives()` | 模拟 Primitives 接口，所有操作可 spy |
| `buildSnapshot(nodes)` | 构造 accessibility tree snapshot |
| `createMockStore()` | 模拟 KnowledgeStore |
| `assertIngestItems(items)` | 校验 IngestItem[] 结构是否符合 Zod schema |

### 7.3 隔离保证

1. **插件之间**：零交叉导入。Twitter 测试不 import Reddit 代码，反之亦然。
2. **插件与框架运行时**：插件测试通过 test kit mock 完成，无需 Chrome 或 MCP server。
3. **框架与具体 site**：框架 contract/integration 测试使用最小化的 `FakeSitePlugin`，不依赖真实 site。
4. **Vitest 路径过滤**：`pnpm test src/sites/twitter` 只跑 Twitter 测试；`pnpm test tests/` 只跑框架测试。

### 7.4 插件契约测试

```ts
// tests/contract/plugin-contract.test.ts
// 使用 FakeSitePlugin 验证框架承诺：

test('从标准能力生成 MCP tools');
test('从自定义 workflow 生成 MCP tools');
test('遵循 expose 配置（仅 mcp、仅 cli）');
test('为每个插件创建隔离的 SiteRuntime');
test('feed.collect 后调用 storeAdapter');
test('未声明 storeAdapter 时不调用 ingest');
test('自动注入 IngestItem 的 site 字段');
test('将插件未知错误包装为 PluginError');
test('per-site 熔断器不影响其他 site');
test('FeedResult 返回值不合法时抛 PluginError');

// 向后兼容 snapshot tests
test('仅 Twitter 时生成的 MCP tool 列表与当前一致（snapshot）');
test('仅 Twitter 时 tool inputSchema 与当前一致（snapshot）');

// 异常场景
test('插件 import 抛异常时 fatal 并报明确路径和原因');
test('插件 detect 运行时抛异常包装为 PluginError');
test('config.json 格式错误时 fatal 并报 JSON 解析错误');
test('外部插件路径找不到时 fatal 并报 import 错误');
```

### 7.5 迁移

当前 `tests/unit/twitter-*.test.ts` 搬到 `src/sites/twitter/__tests__/`，去掉 `twitter-` 前缀（目录已表达归属）。框架级测试文件（`primitives-*.test.ts`、`browser.test.ts` 等）保持在 `tests/unit/`。

---

## 8. 子系统关系

```
┌────────────────────────────────────────────────────┐
│                    入口层                            │
│          server.ts（MCP）    index.ts（CLI）          │
└──────────────┬───────────────────┬─────────────────┘
               │                   │
               ▼                   ▼
┌────────────────────────────────────────────────────┐
│                   Registry                          │
│   discovery.ts — 发现与加载插件                       │
│   codegen.ts   — 生成 MCP tools + CLI 命令           │
│   types.ts     — SitePlugin、WorkflowDeclaration     │
└──────────────┬─────────────────────────────────────┘
               │ 产出插件列表
               ▼
┌────────────────────────────────────────────────────┐
│                   Runtime                           │
│   manager.ts — 懒创建 / 缓存 / 销毁                  │
│   types.ts   — SiteRuntime                          │
│                                                     │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐      │
│   │  twitter   │  │  reddit   │  │   xhs     │      │
│   │  tab+mutex │  │  tab+mutex│  │  tab+mutex │      │
│   │  rateLmDet │  │  rateLimit│  │  rateLimit │      │
│   │  circuit   │  │  circuit  │  │  circuit   │      │
│   │  authState │  │  authState│  │  authState │      │
│   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘      │
└─────────┼──────────────┼───────────────┼────────────┘
          │              │               │
          ▼              ▼               ▼
┌────────────────────────────────────────────────────┐
│                      Ops                            │
│   matchers.ts    — ARIA 匹配辅助                     │
│   ensure-state.ts — 状态转换工具                      │
│   作为 site-use/ops 公开导出供插件作者使用              │
└──────────────┬─────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────┐
│                   Primitives                        │
│   types.ts          — Primitives 接口（8 个操作）     │
│   factory.ts        — 栈构建器                       │
│   puppeteer-backend — CDP 实现                       │
│   click/scroll-enhanced — 拟人化行为                  │
└──────────────┬─────────────────────────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────┐
│                    Browser                          │
│   browser.ts — Chrome 启动、健康检查、重连             │
│   一个共享 Chrome 实例，多个 tab                      │
└────────────────────────────────────────────────────┘

      ┌──────────────────────────────┐
      │           Sites              │
      │   sites/twitter/             │
      │   sites/reddit/              │  ← 被 Registry 发现
      │   sites/xhs/                 │     被 Runtime 调用
      │   (+ 外部 npm 包)             │     依赖 Primitives + Ops
      └──────────────────────────────┘

      ┌──────────────────────────────┐
      │          Storage             │
      │   storage/ — SQLite          │  ← 被 Runtime 在 feed 后调用
      │   KnowledgeStore             │     通过插件的 storeAdapter
      └──────────────────────────────┘

      ┌──────────────────────────────┐
      │          Errors              │
      │   errors.ts — 错误类型        │  ← 横切层，所有模块可 import
      └──────────────────────────────┘

      ┌──────────────────────────────┐
      │         Diagnose             │
      │   diagnose/ — 反检测诊断      │  ← 独立子系统
      │   M8 不涉及                   │     不属于插件架构
      └──────────────────────────────┘
```

### 8.1 依赖规则

- **仅向下依赖**：入口层 → Registry → Runtime → Ops → Primitives → Browser
- **Sites 是被动的**：被 Registry 发现，被 Runtime 调用。Sites 自身只依赖 Primitives 和 Ops——不知道 Registry、Runtime、Storage 的存在。
- **Storage 被 Runtime 调用**：`feed.collect()` 后，Runtime 调用 `storeAdapter` 再调用 `store.ingest()`。Sites 不直接操作 Storage。
- **Errors 是横切的**：所有模块均可 import `errors.ts`。
- **Diagnose 独立**：不受 M8 影响，不属于插件架构。

### 8.2 公开 API 导出

| 导出路径 | 内容 | 消费者 |
|----------|------|--------|
| `site-use` | `Primitives`、`SitePlugin`、核心类型 | 插件作者 |
| `site-use/ops` | `matchByRule`、`ensureState`、ARIA 辅助 | 插件作者 |
| `site-use/testing` | `createMockPrimitives`、`buildSnapshot` 等 | 插件测试 |

---

## 9. 关键设计决策汇总

| 决策 | 选择 | 理由 |
|------|------|------|
| 插件契约风格 | 声明式对象（非注册 API） | 数据描述而非运行时控制。先紧后松，不破坏已有插件。 |
| 能力模型 | 标准 + 自定义 | 通用操作跨 site 一致；特有操作完全灵活。 |
| Feed 入参 | 插件自定义（Zod schema），不统一 | 各 site 差异太大（Twitter tab vs Reddit subreddit vs XHS category）。统一的是输出（FeedResult）。 |
| MCP/CLI 生成 | 框架从声明自动生成 | 插件作者零样板代码；命名和错误处理一致。 |
| 暴露控制 | per-workflow `expose` 字段 | 并非所有 workflow 都需要同时暴露 MCP 和 CLI。 |
| 插件发现 | 配置文件（显式）+ 内置（自动） | 显式比隐式扫描更安全、更透明。 |
| 外部插件格式 | npm 包，与内置导出一致 | 无结构差异；仅加载路径不同。 |
| 插件校验 | 启动时 Zod 校验，失败则 fatal | 前期严格，避免静默失败导致误以为加载成功。 |
| 插件名保护 | 保留名列表，命中则 fatal | 防止 CLI 命令冲突（如 `site-use browser feed` 歧义）。 |
| 运行时隔离 | per-site tab、mutex、限速器、熔断器 | 故障隔离；跨 site 并行；独立登录状态。 |
| 熔断器模型 | 三态（closed → open → half-open），默认阈值 5 次、冷却 60 秒 | 简单计数器只挡一次就放行，对 agent 无保护效果。三态确保冷却期内所有请求被拒绝。 |
| Runtime 并发创建 | per-site Promise 去重，不加全局锁 | 防止同一 site 重复开 tab；不阻塞不同 site 的并行创建。 |
| 共享资源 | 仅 Chrome 实例 | Tab 天然隔离；无需多 Chrome 进程（未来可扩展）。 |
| `screenshot` 多 tab | 必须指定 `site` 参数 | 隐式"截最近活跃 tab"对 agent 不可预测。 |
| 测试 co-location | `src/sites/<name>/__tests__/` | 内置和外部结构一致；天然隔离。 |
| 框架 test kit | `site-use/testing` 公开导出 | 插件作者无需 Chrome 或 MCP server 即可测试。 |
| Display/Format | 不在插件契约中 | MCP 返回结构化 JSON；CLI 格式化是框架层能力。 |
| Store Adapter | 可选，强类型 `FeedItem[]`，运行时 Zod 校验 | 仅 feed 触发自动 ingest；schema 即契约。 |
| 错误提示 | 插件提供 + 框架默认值 | 为 AI agent 提供 site 针对性的恢复建议。 |
| `ops/` 层 | 公开导出供插件作者使用 | 共享工具（匹配器、状态转换）避免跨 site 重复。 |
| API 版本 | `apiVersion: 1`，必填 | 预留版本兼容能力。M8 仅 v1，未来框架可据此向后兼容。 |

---

## 10. 实现注意事项

面向实现者的工程决策，补充设计文档中未覆盖的实操细节。

### 10.1 内置插件发现机制

构建时生成静态注册文件，不做运行时目录扫描：

```ts
// src/sites/_registry.ts（构建时自动生成）
export { plugin as twitter } from './twitter/index.js';
export { plugin as reddit } from './reddit/index.js';
```

理由：运行时 glob 在 npm 包和 bundler 场景中不可靠。静态 import 对 TypeScript 编译器、tree-shaking、类型检查均透明。新增内置 site 后跑 build 即自动重新生成。

外部插件走运行时 `import()` 动态加载，不受此机制影响。

### 10.2 外部插件路径解析

配置文件中的相对路径以 **config.json 所在目录**为基准（即 `~/.site-use/`）：

```jsonc
{
  "plugins": [
    "@site-use/plugin-reddit",        // npm 包名，Node.js 模块解析
    "./my-local-plugin"               // 相对于 ~/.site-use/ 目录
  ]
}
```

### 10.3 Primitives 接口变更

当前每个 Primitives 操作有可选 `site?` 参数（`navigate(url, site?)`、`click(uid, site?)` 等）。M8 后每个 Primitives 实例绑定单个 site，该参数变为冗余。

**M8 中移除 `site?` 参数。** 这是有意的 breaking change，但影响范围仅限框架内部——外部消费者通过 `SitePlugin` 接口与框架交互，不直接构造 Primitives。

### 10.4 Primitives Factory API 改造

```ts
// 当前
buildPrimitivesStack(browser, [twitterSiteConfig])  // 多 site config，共享 browser

// M8 后
buildPrimitivesStack(page, plugin)  // 单个 plugin，单个 page
```

Browser 不再传入 factory——由 `SiteRuntimeManager` 负责管理 Browser 和 Page 的生命周期，factory 只负责在给定 Page 上构建 primitives 栈（throttle → auth-guard → rate-limit-detect）。

### 10.5 全局 Tool 的 Mutex 语义

`screenshot(site='twitter')` 走 Twitter 的 per-site mutex。如果 Twitter 正在执行 feed（持有 mutex），screenshot 请求排队等待。这是合理行为——同一个 tab 上并行操作会互相干扰。

### 10.6 Package.json Exports 配置

公开 API 子路径需要在 `package.json` 中配置 `exports` 字段：

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./ops": "./dist/ops/index.js",
    "./testing": "./dist/testing/index.js"
  }
}
```

同时需要对应的 `.d.ts` 类型声明导出。

### 10.7 依赖说明

MCP SDK（@modelcontextprotocol/sdk）内置 Zod 支持，自动将 Zod schema 转换为 JSON Schema。**不需要额外添加 `zod-to-json-schema` 依赖**。框架只需将 Zod raw shape 传给 `registerTool` 的 `inputSchema`，SDK 自行处理转换。

### 10.8 siteMeta 类型安全

`StoreAdapter.toIngestItems(items: FeedItem[])` 中，插件通过 `as` 断言将 `siteMeta` 转为 site 特有类型。为保证类型安全：

1. 插件内部定义 `XxxSiteMetaSchema`（Zod）
2. 构造 FeedItem 时用 `.parse()` 校验 siteMeta（见 1.1 节 Best Practice）
3. adapter 中 `as` 断言使用**同一个类型定义**

构造时校验 + adapter 共享类型 = 端到端数据完整性。

### 10.9 迁移路径

具体迁移顺序（先建框架还是先改 Twitter、server.ts 如何分步重构、测试何时搬迁）在 writing-plans 阶段细化。设计文档只定义目标状态。
