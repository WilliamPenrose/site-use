# 能力 4：Twitter Sites 层

> 上游文档：[技术架构设计](../../2026-03-17-site-use-design.md) — 站点适配层章节，[M1 里程碑](../overview.md) — 能力 4
> 依赖：[Research Spike](00-research-spike.md) 的结论决定 extractors 策略
> 状态：待讨论

## 目标

实现用户直接感知的两个功能："检查是否登录 Twitter" + "采集 timeline 推文"。这是 M1 的产品价值所在。

---

## 文件

| 文件 | 职责 |
|------|------|
| `src/sites/twitter/types.ts` | 数据结构：Tweet, TweetAuthor, TimelineMeta |
| `src/sites/twitter/matchers.ts` | ARIA 匹配规则 + matchByRule 工具函数 |
| `src/sites/twitter/extractors.ts` | 推文内容提取（策略取决于 research spike） |
| `src/sites/twitter/workflows.ts` | checkLogin + getTimeline 编排 |

---

## 设计理由

### 为什么 Sites 层独立于 Primitives 层

Primitives 层不知道 Twitter 的任何细节（没有 URL、没有 ARIA 规则、没有数据结构），它只提供"操作浏览器"的通用能力。Sites 层包含所有 Twitter 特有的知识：哪些 URL 要导航、哪些 ARIA 规则能匹配按钮、怎么从 DOM 提取推文数据。

这种分离的价值在扩展新站点时体现：加 reddit 支持只需要新建 `sites/reddit/`，完全不碰 Primitives 层的代码。

### 为什么 Sites 层内部分 4 个文件（而不是一个大文件）

Twitter 站点适配涉及 4 种独立变化的关注点：

1. **types.ts** — 数据结构是 MCP client 的接口契约，变更频率最低
2. **matchers.ts** — ARIA 规则在 Twitter UI 改版时变化，但与提取逻辑无关
3. **extractors.ts** — 提取策略可能从 DOM 切换到 GraphQL，但不影响 ARIA 规则和 workflow 编排
4. **workflows.ts** — 编排逻辑在功能变化时调整（如 M2 加新 workflow），但不影响底层的匹配和提取

如果四者放在一个文件里，改提取策略时要在 1000 行文件里找到对应位置，而且 git diff 会把不相关的代码混在一起。

---

## 子模块 A：types.ts — 数据结构

M1 定义的核心类型，对应 PRD 中的简报输出需求。

### Tweet

```typescript
{
  id: string              // 推文 ID（从链接提取）
  author: TweetAuthor
  text: string            // 完整推文文本
  timestamp: string       // ISO 8601（如可获取），否则相对时间字符串
  url: string             // 推文永久链接 https://x.com/handle/status/ID
  metrics: {
    likes?: number
    retweets?: number
    replies?: number
  }
  isRetweet: boolean
  isAd: boolean           // 广告标记，用于过滤
}
```

### TweetAuthor

```typescript
{
  handle: string   // 如 "karpathy"（不含 @）
  name: string     // 如 "Andrej Karpathy"
}
```

**为什么 M1 用 `TweetAuthor` 而不是完整的 `User` 类型**：完整的 `User`（含 bio、followers、avatarUrl）需要访问用户 profile 页面才能提取。M1 只采集 timeline，timeline 中一条推文只包含作者的 handle 和 display name，不包含 bio 和粉丝数。定义还没有数据来源的字段是自欺欺人。M2 实现 `getFollowingList` 和 `searchUser` 时会访问 profile 页面，届时定义完整 `User`。

### TimelineMeta

满足 PRD 的"覆盖面透明度"要求——让用户知道这次采集覆盖了谁：

```typescript
{
  tweetCount: number          // 采集的推文总数（过滤广告后）
  coveredUsers: string[]      // 本次出现的用户 handle 列表
  coveredUserCount: number    // 覆盖的独立用户数
  timeRange: {
    from: string              // 最早推文时间戳
    to: string                // 最晚推文时间戳
  }
}
```

Caller（Skill）可以将 `coveredUsers` 与 following 列表对比，识别被 Twitter 算法过滤掉的 KOL。

### TimelineResult

```typescript
{
  tweets: Tweet[]
  meta: TimelineMeta
}
```

---

## 子模块 B：matchers.ts — ARIA 匹配规则

### 设计原则

- 不使用 CSS 选择器，使用辅助功能树的 `role` + `name` 语义匹配（详见[技术架构设计 — matchers.ts](../../2026-03-17-site-use-design.md)）
- 所有 Twitter 匹配规则集中在此文件——Twitter UI 改版时只改这里
- 通过 `Matcher` 接口抽象，M4 可以换成 `CompositeMatcher`（ARIA → 指纹 fallback），workflow 不改

**为什么 matchers 和 extractors 是分开的两个模块**：

matchers 负责**操作定位**（"Follow 按钮在哪"），extractors 负责**内容提取**（"这条推文说了什么"）。两者的技术路径不同：

- matchers 用辅助功能树（ARIA role + name）——因为按钮、链接等可交互元素在辅助功能树中有明确的语义标识
- extractors 可能用 DOM 解析、JS 状态对象、甚至 GraphQL 拦截——因为内容数据的最佳提取路径取决于 Twitter 前端实现（这正是 research spike 要回答的问题）

两者独立变化：Twitter 改了按钮文案只需要改 matchers；Twitter 改了 DOM 结构只需要改 extractors。

### MatcherRule 结构

```typescript
{
  role: string           // ARIA role，精确匹配
  name: string | RegExp  // 无障碍名称，字符串精确匹配或正则
}
```

### M1 需要的匹配规则

M1 只有 checkLogin + getTimeline 两个 workflow，需要的规则很少：

| 规则名 | 用途 | role | name 模式 |
|--------|------|------|----------|
| `homeNavLink` | 登录态检测：已登录用户才有 Home 导航链接 | `link` | `/^Home$/i` |
| `tweetComposeButton` | 登录态检测备选：发推按钮只有登录用户可见 | `link` | `/compose/i` |

> **注意**：M1 的 matchers 主要服务于**操作定位**（checkLogin 需要确认登录状态）。内容提取（extractors）走 `evaluate()`，可能完全不依赖 ARIA 匹配。M2 会增加 follow 按钮、搜索框等更多规则。

### matchByRule() 工具函数

```typescript
matchByRule(snapshot: Snapshot, rule: MatcherRule): string | null
```

遍历 snapshot 的 `idToNode`，返回第一个匹配的 uid，或 null。

```typescript
matchAllByRule(snapshot: Snapshot, rule: MatcherRule): string[]
```

返回所有匹配的 uid 列表。

### Matcher 接口（为 M4 预留）

M1 直接用 `matchByRule()` 函数。但 workflow 中的调用模式已经为 M4 的 `CompositeMatcher` 做好准备：

```
M1: matchByRule(snapshot, rule) → uid | null → 没找到就抛 ElementNotFound
M4: compositeMatcher.match(snapshot, ruleName) → uid | null → 没找到先查指纹 fallback
```

M4 替换时，workflow 中只需要把 `matchByRule(snapshot, rule)` 改为 `matcher.match(snapshot, ruleName)`，改动极小。

---

## 子模块 C：extractors.ts — 内容提取

### 依赖 Research Spike

提取策略取决于 [00-research-spike.md](00-research-spike.md) 的结论。此处描述模块接口和职责边界，具体实现在 spike 完成后确定。

关于 5 层提取策略栈的完整定义、优先级和触发条件，详见[技术架构设计 — extractors.ts 内容提取](../../2026-03-17-site-use-design.md)。M1 只实现第 2、3 层。

### 架构预留（不写代码，确保设计不阻断）

以下三条架构预留来自[技术架构设计 — LLM 兜底路径的架构预留](../../2026-03-17-site-use-design.md)，M1 实现时需遵守：

- **R1：Extractor 接口不暴露提取策略** — extractor 对 workflow 暴露统一签名 `(primitives) => Promise<RawTweetData[]>`，workflow 不关心内部用的是 DOM 解析还是 JS 状态对象。下文的"模块内部分两层"正是 R1 的体现。
- **R2：清洗层独立性** — 如果提取过程中需要 DOM 清洗逻辑，应作为独立工具函数，不绑定在特定提取路径内部。
- **R3：Zod 作为唯一 schema 来源** — types.ts 中的 `Tweet`、`TweetAuthor` 等类型应用 Zod schema 定义（MCP SDK 的工具注册本身依赖 Zod），确保未来 LLM 兜底路径可复用同一 schema。

### 职责

- 从当前 timeline 页面提取推文原始数据
- 将原始数据解析为结构化 `Tweet` 对象
- 从 `Tweet[]` 构建 `TimelineMeta`

### 模块内部分两层

```
extractTweetsFromPage(primitives)    → RawTweetData[]     // 浏览器端提取，策略相关
parseTweetFromDOM(raw)               → Tweet              // Node 端解析，纯函数
buildTimelineMeta(tweets)            → TimelineMeta       // 纯函数
```

**为什么分两层**：
- `extractTweetsFromPage` 依赖浏览器环境（`evaluate()`），不可单元测试
- `parseTweetFromDOM` 和 `buildTimelineMeta` 是纯函数，可以用固定输入数据单元测试
- 未来切换提取策略（如从 DOM 改为 GraphQL），只改 `extractTweetsFromPage`，解析层不变

### RawTweetData — 浏览器端提取的原始数据

```typescript
{
  authorHandle: string
  authorName: string
  text: string
  timestamp: string
  url: string
  likes: number
  retweets: number
  replies: number
  isRetweet: boolean
  isAd: boolean
}
```

这是浏览器端 `evaluate()` 返回值的类型。它隔离了浏览器端提取逻辑和 Node 端解析逻辑。

### 测试策略

- `parseTweetFromDOM()`：单元测试，构造 `RawTweetData` 输入验证解析逻辑
- `buildTimelineMeta()`：单元测试，构造 `Tweet[]` 输入验证汇总逻辑
- `extractTweetsFromPage()`：集成测试，需要真实 Twitter 页面

---

## 子模块 D：workflows.ts — 编排逻辑

### 设计原则

- Workflow 是**原子的**：只做浏览器操作和数据提取，不做 AI 分析
- Workflow 组合 primitives + matchers + extractors，不直接调 Puppeteer
- 每个 workflow 对应一个 MCP tool

**为什么 workflow 不做 AI 分析**：site-use 的定位是"确定性 workflow 工具"，把 AI 专注于内容理解而非页面操作。如果 `getTimeline` 内部调 LLM 做摘要，那 site-use 就变成了一个 AI agent，与产品定位矛盾。保持原子性：site-use 输出结构化数据，AI 分析由上层 Skill（OpenClaw 或 Claude）完成。这也意味着 site-use 的调用成本是确定的（只有浏览器操作开销，没有 LLM token 开销）。

**外部内容不可信**（[技术架构设计 — 模块边界原则 #4](../../2026-03-17-site-use-design.md)）：未来如果引入 LLM 兜底提取路径（策略栈第 5 层），任何将页面内容传给 LLM 的路径必须加入对抗性文本防护（prompt injection 防御）。M1 不涉及 LLM 路径，但 extractors 的接口设计（R1）已为此预留。

**为什么 workflow 不直接调 Puppeteer**：workflow 通过 Primitives 接口操作浏览器。这保证了：(1) 所有操作经过 throttle 节流，(2) 未来切换到 devtools-mcp-backend 时 workflow 零改动，(3) 测试时可以 mock Primitives。唯一的例外是通过 `getRawPage()` escape hatch，但这在 M1 中仅用于代理认证（在 server.ts 中，不在 workflow 中）。

### checkLogin()

**用途**：检测用户是否已登录 Twitter。MCP tool `twitter_check_login` 的 handler。

**流程**：

```
1. navigate('https://x.com/home')
2. evaluate() 获取当前 URL
3. URL 包含 /login 或 /i/flow/login → 返回 { loggedIn: false }
4. takeSnapshot() 获取辅助功能树
5. matchByRule(snapshot, matchers.homeNavLink)
6. 匹配到 → 返回 { loggedIn: true }
7. 没匹配到 → 返回 { loggedIn: false }
```

**为什么 checkLogin 不抛异常**：未登录不是错误状态——它是首次使用时的正常情况。如果 checkLogin 抛 `SessionExpired`，caller 需要 try-catch 来区分"未登录"和"真正的错误"。返回 `{ loggedIn: false }` 是更自然的查询语义，让 AI agent 可以据此引导用户"请在 Chrome 窗口中登录"。

相对地，`getTimeline` 调用的内部 `requireLogin()` 确实抛 `SessionExpired`——因为"采集推文但没登录"是操作前提不满足，属于错误。查询和操作的错误语义不同。

### getTimeline(count)

**用途**：采集 timeline 推文。MCP tool `twitter_timeline` 的 handler。

**前置条件**：已登录。调用内部的 `requireLogin()` 检查，未登录抛 `SessionExpired`。

**流程**：

```
1. requireLogin(primitives)
   └─ 内部调用 checkLogin()，未登录则抛 SessionExpired

2. 已在 x.com/home（requireLogin 已导航）

3. 滚动采集循环：
   ├─ evaluate() 统计当前页面推文数量
   ├─ 数量 >= count → 退出循环
   ├─ scroll({ direction: 'down' })
   ├─ 停滞检测：连续 N 次滚动无新推文 → 退出循环
   └─ 继续循环

4. extractTweetsFromPage(primitives) → RawTweetData[]

5. parseTweetFromDOM() 转为 Tweet[]
   └─ 过滤广告（isAd = true）
   └─ 截取前 count 条

6. buildTimelineMeta(tweets)

7. 返回 { tweets, meta }
```

### requireLogin() — 内部 auth guard

```
调用 checkLogin(primitives)
├─ loggedIn: true → 继续
└─ loggedIn: false → 抛 SessionExpired({ url: 当前URL })
```

M1 是显式调用（workflow 手动调 `requireLogin`）。M3 将其改为自动中间件（小型结构重构，检测逻辑不变）。

### 停滞检测

Timeline 的无限滚动可能会出现加载不出新内容的情况（到达底部、网络问题、Twitter 限流等）。

策略：连续 `MAX_STALE_ROUNDS`（默认 3）次滚动后推文数量没有增加 → 停止滚动，用已获取的内容返回。

**为什么是"连续 3 次"而不是"1 次没新内容就停"**：网络延迟可能导致某次滚动后新内容还没加载完。给 3 次机会能容忍短暂的加载延迟，同时避免无限等待。这个阈值参考了 xiaohongshu-mcp 的评论滚动加载实现中的停滞检测逻辑。

**为什么不用固定等待时间（如"滚动后等 5 秒"）**：固定等待在网络快的时候浪费时间，网络慢的时候又不够。停滞检测是**基于结果的**判断——看实际加载到的推文数量有没有变化——比基于时间的猜测更可靠。

---

## 模块间调用关系

```
workflows.ts
  ├── 调用 → primitives (navigate, takeSnapshot, scroll, evaluate)
  ├── 调用 → matchers.ts (matchByRule)
  ├── 调用 → extractors.ts (extractTweetsFromPage, parseTweetFromDOM, buildTimelineMeta)
  ├── 使用 → types.ts (Tweet, TimelineResult 等类型)
  └── 抛出 → errors.ts (SessionExpired, ElementNotFound)
```

---

## 测试策略

| 模块 | 测试方式 |
|------|---------|
| types.ts | 纯类型，不需要运行时测试 |
| matchers.ts | 单元测试：构造 Snapshot，验证 matchByRule 行为 |
| extractors.ts（parseTweetFromDOM, buildTimelineMeta） | 单元测试：构造固定输入，验证解析和汇总逻辑 |
| extractors.ts（extractTweetsFromPage） | 集成测试：需要真实 Twitter 页面 |
| workflows.ts | 集成测试：需要真实 Chrome + Twitter 登录态 |

---

## 对未来的支持

| 决策 | 为什么不会返工 |
|------|--------------|
| matchers 对象结构 | M2 往里加规则，结构不变 |
| `matchByRule()` 函数 | M4 换 CompositeMatcher 时改动极小 |
| extractors 两层分离 | 换提取策略只改 `extractTweetsFromPage`，解析层不变 |
| TimelineMeta 完整返回 | 产品差异化关键——"覆盖了谁"，M1 就提供 |
| checkLogin 的显式调用 | M3 改为中间件，逻辑不变 |
| workflow 不做 AI 分析 | 分析属于 Skill 层，site-use 只提供数据 |
