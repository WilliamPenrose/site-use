# site-use 里程碑拆解

> 日期：2026-03-19
> 状态：M1 实施中 — 能力 0/1/2/3 已完成，能力 4（Twitter Sites）待实施
> 上游文档：[技术架构设计](../site-use-design.md)

## 策略

按架构层自底向上构建，但每个里程碑包装为独立可交付的产品形态。每个里程碑是前一个的增量——不返工已完成的里程碑。

### 设计原则

1. **增量式，非迭代式** — 每个里程碑添加能力，不修改已有代码
2. **接口先行** — 完整定义接口，渐进实现
3. **可插拔设计** — Matcher 接口、throttle 策略、Primitives 后端均可替换
4. **自用 + 外部反馈** — 每个里程碑自己能用，外部用户能体验

---

## 关键设计决策追溯

本节将架构设计文档中的核心决策映射到具体里程碑，确保每个决策都有归属、有理由。

### 架构选择及理由

> 每项决策的详细理由见[技术架构设计](../site-use-design.md)，此处仅追踪里程碑归属。

| 设计决策 | 选择 | 里程碑归属 |
|----------|------|-----------|
| 对外接口 | MCP Server（stdio） | M1 能力 3 |
| 浏览器控制 | Puppeteer + CDP 直连 | M1 能力 2 |
| Primitives 对齐 devtools-mcp | 接口命名/参数/返回值完全对齐 | M1 能力 2 |
| 元素定位 | snapshot uid，非 CSS 选择器 | M1 能力 4 |
| 多页面管理 | 固定 `Map<site, Page>` | M1 能力 2 |
| 实现语言 | TypeScript | M1 能力 5 |
| 进程模型 | MCP Server 常驻进程 | M1 能力 3 |
| Chrome 启动 | site-use 负责启动（独立 profile） | M1 能力 1 |
| Throttle 挂载点 | Primitives 层包装 | M1 能力 2 → M3 增强 |
| Mutex 串行化 | 全局 Mutex | M1 能力 3 |
| Lazy Chrome | 第一个 tool call 才启动 | M1 能力 3 |
| 退出不关闭 Chrome | server 退出时保留 | M1 能力 3 |
| 错误处理哲学 | 只检测/分类/抛出，不做恢复 | M1 基础 → M3 增强 |
| KOL 列表 | 不做本地缓存 | M2 |
| 首次使用编排 | 属于 caller（Skill） | M1 验证场景 |
| 深挖策略 | 不做 `getTweetDetail` | M2（确认排除） |
| 指纹存储 | better-sqlite3 | M4 |
| `interceptRequest` | site-use 扩展原语 | M1（research spike 结论：GraphQL 拦截为 Twitter 主力提取策略） |
| Fingerprint 推迟到 M4 | 先跑起来再加防护网 | M4 |

### 与 devtools-mcp 的有意差异

> 详见[技术架构设计 — 与 devtools-mcp 的关系](../site-use-design.md#primitives-层与-devtools-mcp-同构)。此处仅记录里程碑相关要点：实现时不应"补齐"这些差异，它们是有意简化。

### 排除决策

> 详见[技术架构设计 — 有意不做的事项](../site-use-design.md)。此处仅列出里程碑归属相关的排除项。

| 不做什么 | 里程碑影响 |
|----------|-----------|
| `getTweetDetail` workflow | M2 确认排除 |
| KOL 列表本地缓存 | M2 确认排除 |
| Fingerprint 推迟到 M4 | M1-M3 不引入 |

### 模块边界原则

> 详见[技术架构设计 — 模块边界](../site-use-design.md)。跨所有里程碑适用，实现时以设计文档为准。

### 反爬三层体系总览

设计文档定义了三层反爬体系，分散在不同里程碑实现：

| 层 | 关注点 | 里程碑 | 具体措施 |
|----|--------|--------|----------|
| 第 1 层：浏览器指纹 | 让 Chrome 像正常用户 | M1 基础 + M3 增强 | M1：去掉 automation 标志、本地 Chrome、独立 profile、随机 CDP 端口、代理支持。M3：Canvas 噪声（防跨站关联）、WebRTC 泄露防护（代理模式防 IP 泄露） |
| 第 2 层：操作行为 | 操作节奏像真人 | M1 基础 + M3 增强 | M1：操作间随机延迟（1-3s）。M3：点击抖动（±3px）、渐进式滚动、站点级频率控制 |
| 第 3 层：会话特征 | 站点级反爬应对 | M3 | 限流信号检测（429 / 验证码页面）→ 抛 `RateLimited`，不做自动恢复 |

核心思路：site-use 用**真实 Chrome 环境**，所以不需要伪造层（WebGL、TLS、Client Hints 等），只需要控制行为节奏和基本指纹隐蔽。

### 待解决问题追踪

设计文档中的待解决问题，在里程碑中的归属：

| # | 问题 | 归属 | 状态 |
|---|------|------|------|
| 1 | 内容提取策略（5 层策略栈：① GraphQL/API 拦截 → ② JS 状态对象 → ③ ARIA+DOM 解析 → ④ Fingerprint 重定位 → ⑤ LLM 兜底提取） | Research spike 已完成（2026-03-19）：Twitter 采用第 1 层（GraphQL 拦截），`interceptRequest` 提前到 M1；LLM 兜底在多站点扩展时按需引入 | ✅ 已解决 |
| 2 | 数据目录布局 | M1 能力 1（`SITE_USE_DATA_DIR`，默认 `~/.site-use/`） | 已确定 |
| 4 | 自愈匹配引擎 | M4（双层匹配：ARIA + 指纹 fallback） | 已确认方案 |
| 5 | 反爬深度 | M1 基础 + M3 增强（见反爬三层体系总览） | 已规划 |
| 6 | Puppeteer 辅助功能树一致性验证 | M1 能力 2（takeSnapshot 是最核心技术点） | 待验证 |
| 7 | 扩展同步（从主 profile 同步扩展到专用 profile） | 未分配里程碑 | MVP 手动安装，未来再考虑 |
| 8 | 无限滚动加载模式（停滞检测 + 数量阈值） | 未分配里程碑 | 现有 Primitives 已够用，是 workflow 层编排模式 |

---

## 里程碑总览

```
M1："读你的 Twitter Timeline"
├── Browser 层（完整）
├── Primitives 层（实现 7/8 原语，含 interceptRequest）
├── MCP Server 骨架（完整）
└── Twitter Sites 层（checkLogin + getTimeline）

M2："完整的 Twitter 自动化"（在 M1 基础上增量）
├── Primitives 层（+1 原语：type）
└── Twitter Sites 层（+4 workflows：searchUser、followUser、getFollowingList、getUserTweets）

M3："可靠地长期运行"（在 M1/M2 基础上增强）
├── Throttle + 反爬增强（行为层 + 指纹层）
├── Auth Guard 自动中间件
└── 错误处理体系（5 类错误 + 上下文 + 自动截图）

M4："Twitter 改版也不怕"（独立新增层）
├── Fingerprint 层（fingerprint.ts + storage.ts）
└── CompositeMatcher（ARIA 优先 → 指纹 fallback）
```

---

## 避免返工的保证

M1 中做出的决策，确保后续里程碑不需要返工：

| 决策 | M1 的实现 | 为什么不会返工 |
|------|----------|--------------|
| Primitives 接口 | `primitives.ts` 定义全部 8 个原语类型，M1 实现 7 个（navigate、takeSnapshot、click、scroll、evaluate、screenshot、interceptRequest） | M2 只加实现（type），接口不改 |
| Matcher 接口 | 抽象 `Matcher` 接口，M1 只提供 `ARIAMatcher`（设计文档展示了函数式示例，里程碑将其抽象为可替换的 Matcher 接口，需在 M1 实施计划中明确定义） | M4 换成 `CompositeMatcher`，workflow 不改 |
| Throttle 挂载点 | Primitives 经过 throttle 包装后再暴露给 Sites 层 | M3 增强 throttle 内部策略，包装方式不变 |
| Matchers 结构 | `matchers` 对象 + 规则条目 | M2 往对象里加规则，结构不变 |
| 错误类型 | 基础错误类型：`ElementNotFound`、`SessionExpired`、`BrowserDisconnected`，每个错误携带基础上下文（`url` + `message`） | M3 增加 `RateLimited`、`NavigationFailed`，并增强为完整上下文（操作步骤、页面状态、自动截图） |
| MCP 工具注册 | 注册机制是最终形态 | M2 用同样模式注册更多 tool |
| 多页面管理 | `Map<site, Page>` 结构就位 | 未来站点只加 entry，结构不变 |
| 数据目录 | `SITE_USE_DATA_DIR` 环境变量（默认 `~/.site-use/`），所有路径从根目录派生 | M4 的 SQLite 放在同一根目录下，路径约定不变 |

### 可插拔组件

M1 中设计的三个扩展点，供未来替换：

| 扩展点 | M1 的实现 | 未来的替换选项 |
|--------|----------|--------------|
| **Matcher** | `ARIAMatcher`（辅助功能树 role + name 匹配） | `CompositeMatcher`（ARIA → 指纹 fallback，M4）、`CSSMatcher`（用于 ARIA 不完善的站点）、AI 视觉匹配 |
| **Throttle 策略** | 基础随机延迟（1-3s），接受站点级配置覆盖 | 增强策略（点击抖动 ±3px、渐进滚动、站点级频率上限，M3） |
| **Primitives 后端** | `puppeteer-backend.ts`（进程内 Puppeteer） | `devtools-mcp-backend.ts`（MCP client 适配器，转发到已有 devtools-mcp 服务） |

---

## M1："读你的 Twitter Timeline"

> 详细设计 — 第一个要实现的里程碑

### 产品形态

用户配置 MCP client，对 AI 说"Twitter 上最近在聊什么"，site-use 自动启动 Chrome、检查登录态、采集 timeline 推文，返回结构化数据给 AI 做分析。

### 暴露的 MCP 工具（3 个）

| 工具 | 作用 | 产品价值 |
|------|------|---------|
| `twitter_check_login` | 检测是否已登录 Twitter | AI 可以引导"请在弹出的 Chrome 中登录" |
| `twitter_timeline` | 采集 timeline 推文 | 核心价值 —— "帮我读 Twitter" |
| `screenshot` | 截图当前页面（`site` 参数可选，默认截取最近使用的页面） | 调试 + AI 可以看到页面实际状态 |

### 能力拆解（5 个能力）

#### 前置任务：提取策略 Research Spike

**M1 开始前**，需要先验证 Twitter timeline 推文能否通过 `evaluate()`/DOM 解析提取。如果不行（例如推文时间戳只能通过 GraphQL 获取），则需要将 `interceptRequest` 提前到 M1。

本次 research spike 按照[技术架构设计 — 新站点接入决策流程](../site-use-design.md)执行——Twitter 是第一个实例，同时也验证该流程本身的可用性。后续扩展新站点时沿用同一流程。

**验证方法**（对应决策树三步）：

1. **网络层检查**：打开 DevTools Network 面板，操作 timeline 页面（滚动、刷新），观察 GraphQL / REST API 请求。记录：API 是否返回 JSON？endpoint 是否带 hash？是否需要认证 token？
2. **JS 状态检查**：Console 面板检查 `window.__INITIAL_STATE__`、`window.__NEXT_DATA__`、React fiber/store 等全局状态对象。`evaluate()` 能否直接读到推文数据？
3. **DOM 结构检查**：检查推文容器的语义化标签（`<article>`、`role` 属性等），关键字段（文本、作者、时间戳）能否用稳定选择器定位。时间戳是绝对值还是相对格式？

**已完成（2026-03-19）**。结论：采用 Path D（GraphQL 拦截，策略栈第 1 层），M1 范围已扩大（`interceptRequest` 提前到 M1，实现 7/8 原语）。Path B（DOM 解析）作为降级方案保留。详见 [00-research-spike.md](m1/00-research-spike.md)。

**策略决策记录**：

```
Site: twitter.com (x.com)
Extraction strategy: GraphQL interception (strategy stack layer 1)
  - Primary: intercept /i/api/graphql/.../HomeLatestTimeline response
  - Fallback: DOM parsing via data-testid selectors (strategy stack layer 3)
Operation strategy: ARIA matching (confirmed: role="article" present, buttons/links have accessible names)
Anti-crawl level: Medium
Special notes: Infinite scroll triggers new GraphQL requests (same endpoint)
```

**新站点接入决策流程**：详见[技术架构设计 — 新站点接入决策流程](../site-use-design.md)（含决策树、站点分类矩阵、research spike 清单）。Twitter 的 research spike 同时验证此流程本身的可用性，后续新站点沿用同一流程。

#### 能力 1：Browser 层 — 启动并连接 Chrome

**产品效果**：用户执行 `npx site-use`，弹出一个干净的浏览器窗口。无需手动配置 Chrome。

**范围**：
- `browser.ts`：启动 Chrome（独立 profile + 随机 CDP 端口 + 去掉 automation 标志 + `channel: 'chrome'` 自动发现）
- 代理支持：`SITE_USE_PROXY` 环境变量 → Chrome `--proxy-server` 参数（在国内访问 Twitter 的前提条件）
- 代理认证：`SITE_USE_PROXY_USER` / `SITE_USE_PROXY_PASS` 环境变量 → `page.authenticate()`
- 数据目录：`SITE_USE_DATA_DIR` 环境变量（默认 `~/.site-use/`），子目录：`chrome-profile/`
- 浏览器单例 + 断线检测（`browser.connected` 检查）
- 非 headless（用户看得到浏览器 — 产品特性，不是技术限制）
- 使用用户本地安装的 Chrome（不用 Puppeteer 自带的 Chromium）— `channel: 'chrome'`

**对未来的支持**：
- 数据目录结构为 M4 的 SQLite 预留位置：`~/.site-use/data/`
- Chrome 启动参数是增量的 — M3 添加 Canvas 噪声和 WebRTC 标志，不修改已有参数
- 代理支持 M1 就完整实现（不推迟）— 没有代理在国内连不上 Twitter

#### 能力 2：Primitives 层 — 浏览器操作原语

**产品效果**：提供统一的浏览器操作接口，workflow 不直接调用 Puppeteer（escape hatch 除外：Primitives 接口提供 `getRawPage(site): Page` 方法，供极少数 Primitives 覆盖不了的特殊操作使用，但这是例外不是常态）。

**M1 实现 7/8 原语**（timeline workflow + GraphQL 拦截提取）：

| 原语 | M1 | 理由 |
|------|-----|------|
| `navigate(url)` | ✅ | 导航到 x.com/home |
| `takeSnapshot()` | ✅ | 获取辅助功能树，定位元素 |
| `click(uid)` | ✅ | 关闭弹窗、交互元素 |
| `scroll(options)` | ✅ | 滚动加载更多推文 |
| `evaluate(fn)` | ✅ | 提取推文内容数据 |
| `screenshot()` | ✅ | 作为 MCP 工具暴露，调试用 |
| `type(uid, text)` | ❌ → M2 | M1 没有文本输入操作（搜索在 M2） |
| `interceptRequest()` | ✅ | Research spike 结论：GraphQL 拦截为 Twitter 主力提取策略 |

**对未来的支持**：
- `primitives.ts` 定义**全部 8 个原语**的 TypeScript 类型。`puppeteer-backend.ts` M1 实现 7 个；仅 `type` 抛 `NotImplemented`
- Throttle 包装方式 M1 就定好：原语经过 throttle 包装后再暴露给 Sites 层。M1 的 throttle = 基础随机延迟（1-3s）。M3 增强内部策略（点击抖动、渐进滚动），包装方式不变
- 多页面 `Map<site, Page>` M1 就实现，只有 twitter 一个 entry。未来站点只加 entry，结构不变
- `takeSnapshot()` 的实现（CDP `Accessibility.getFullAXTree` → uid 映射 → backend node ID）是整个系统最核心的技术点，M1 必须验证它和 devtools-mcp 的行为一致

**uid 生命周期规则**（所有 workflow 必须遵守）：
- `evaluate()` 不修改 DOM，不会使 uid 失效，可与 click/type 自由混合（走不同 CDP 路径）
- DOM 变化（click、导航、动态加载）使 uid 失效，需重新 `takeSnapshot()`
- 推荐操作顺序：`evaluate`（读数据做业务决策）→ `takeSnapshot`（获取最新辅助功能树）→ `click(uid)`（操作）
- 这些规则来自 devtools-mcp 的 snapshot uid 语义，是 Primitives 层的契约

#### 能力 3：MCP Server 骨架 — 工具注册 + 生命周期

**产品效果**：用户在 Claude Desktop / Cursor 的 MCP 配置里加一行 `"command": "npx site-use"`，就能用了。

**范围**：
- `@modelcontextprotocol/sdk` + `StdioServerTransport`
- 工具注册机制（Zod schema 定义参数）
- Mutex 串行化所有 tool call（保证浏览器状态一致性——同一时刻只操作一个 tab）
- 浏览器状态机：IDLE → 收到 tool call → 启动 Chrome → ACTIVE → MCP 断开 → 退出（不关闭 Chrome）
- Lazy Chrome：第一个 tool call 才启动浏览器，不是 server 启动时
- 断线恢复：每次 tool call 前检查 `browser.connected`

**对未来的支持**：
- 工具注册机制是最终形态 — M2 用同样模式注册更多 tool
- Mutex、状态机、Lazy Chrome、断线恢复 — 全是 MCP Server 基础设施，M1 后不需要改
- 错误输出协议 M1 就定好（JSON 格式 + `isError: true`）— M3 丰富错误类型但协议不变
- 进度通知：M1 支持 MCP 协议的 progress notification（可选，取决于 client 是否支持），用于 `getTimeline` 等耗时操作的进度反馈

#### 能力 4：Twitter Sites 层（最薄切片）— checkLogin + getTimeline

**产品效果**：用户直接感知的功能 —— "帮我检查登录" + "帮我读 timeline"。

**范围**：
- `matchers.ts`：2-3 条 ARIA 匹配规则（timeline 页面相关元素，如检测登录态用的发推按钮）
- `workflows.ts`：`checkLogin()` + `getTimeline(count)`
- `extractors.ts`：timeline 内容提取（依赖前置 research spike 的结论）
- 核心数据结构：`Tweet`、`TweetAuthor`、`TimelineMeta`
- 登录态检测：`checkAuth()` 函数放在 `sites/twitter/workflows.ts` 中（URL 检查 + 辅助功能树元素检查），workflow 显式调用。检测到未登录 → 抛 `SessionExpired`（恢复策略属于 caller/Skill——Skill 有 AI 能力和用户上下文来引导用户重新登录）。M3 将其提取为通用中间件并自动触发（小型结构重构，检测逻辑不变）
- 基础错误类型：`ElementNotFound`（ARIA 匹配失败）、`SessionExpired`（登录态丢失）、`BrowserDisconnected`（Chrome 断开且重连失败）。每个错误携带基础上下文（`url` + `message`）。M3 增强为完整上下文（操作步骤、页面状态、自动截图）

**数据结构**（M1 定义）：

```
Tweet: { id, author: TweetAuthor, text, timestamp, url, metrics, isRetweet, isAd }
TweetAuthor: { handle, name }
TimelineMeta: { tweetCount, coveredUsers, coveredUserCount, timeRange: { from, to } }
```

> 注意：完整的 `User` 类型（含 bio、followers、avatarUrl）在 M2 实现 `getFollowingList` 时定义——需要实际抓取用户 profile 页面来验证字段可用性。

**对未来的支持**：
- `matchers` 对象结构 + `Matcher` 接口 M1 就定好。M2 加规则；M4 换 matcher 实现
- M1 的 `ARIAMatcher`：匹配失败 → 直接抛 `ElementNotFound`（不调 Fingerprint）。M4 的 `CompositeMatcher` 内部加 fallback 分支；workflow 不改
- `extractors.ts` 作为独立模块 M1 就分离出来。即使 M2 升级提取策略，extractor 接口不变（输入参数 + 输出 `Tweet[]`），仅调用时机可能微调
- `TimelineMeta` M1 就返回完整结构（`coveredUsers`、`timeRange` 等）— 这是产品差异化的关键（"这次采集覆盖了哪些人"）

**提取策略栈**：详见[技术架构设计 — 内容提取策略](../site-use-design.md)（含 5 层策略定义、优先级、R1/R2/R3 架构预留）。里程碑归属：

| 层 | 策略 | 里程碑 |
|----|------|--------|
| 1 | GraphQL / API 拦截 | M1（主力，research spike 结论） |
| 2 | JS 状态对象 | ❌ Twitter 不可用（spike 验证） |
| 3 | ARIA + DOM 解析 | M1（降级方案） |
| 4 | Fingerprint 重定位 | M4 |
| 5 | LLM 兜底 | 多站点扩展时按需引入 |

M1 主力为第 1 层（GraphQL 拦截），第 3 层（DOM 解析）作为降级。每个站点的 research spike 决定从哪层开始。

#### 能力 5：项目工程基础

**产品效果**：`npx site-use` 能跑起来；开发者能 `git clone && npm install && npm run dev` 开始贡献。

**范围**：
- `package.json`（dependencies、bin 入口、npm scripts）
- `tsconfig.json`
- `.gitignore`（含 `chrome-profile/`、`*.db` 等）

**项目目录结构**：
```
src/
├── server.ts                    # MCP Server 入口
├── browser/
│   └── browser.ts               # Chrome 生命周期
├── primitives/
│   ├── primitives.ts            # 接口定义（全部 8 个）
│   ├── puppeteer-backend.ts     # 实现（M1：7 个）
│   └── throttle.ts              # 基础节流
└── sites/
    └── twitter/
        ├── matchers.ts          # ARIA 匹配规则
        ├── workflows.ts         # checkLogin + getTimeline
        └── extractors.ts        # 内容提取
```

**对未来的支持**：
- 目录结构为后续预留位置：`sites/reddit/`（未来站点）、`primitives/devtools-mcp-backend.ts`（未来后端切换）、`fingerprint/`（M4）
- M1 **不创建空目录或占位文件** — 只创建当前需要的

### M1 验证场景

```
用户：在 Claude Desktop MCP 配置中添加 site-use
    ↓
AI：  调用 twitter_check_login → { loggedIn: false }
AI：  "请在弹出的 Chrome 窗口中登录 Twitter"
    ↓
用户：在 Chrome 中手动登录
    ↓
AI：  再次调用 twitter_check_login → { loggedIn: true }
AI：  调用 twitter_timeline({ count: 30 })
    ↓
site-use：导航到 x.com/home → 滚动采集 → 返回 Tweet[] + TimelineMeta
    ↓
AI：  分析推文内容，生成摘要报告
```

---

## M2："完整的 Twitter 自动化"

> 概要 — M1 完成后再出详细设计文档

### 新增能力

| 能力 | 依赖 M1 的什么 | 新增内容 |
|------|----------------|---------|
| Primitives 补全 | 接口已定义，加实现 | `type(uid, text)`（`interceptRequest` 已在 M1 实现） |
| 搜索用户 | Primitives `type` + Matcher 接口 | `searchUser(query)` workflow + 搜索相关 matchers |
| 关注用户 | Primitives `click` + Matcher 接口 | `followUser(handle)` workflow + follow 相关 matchers |
| 获取关注列表 | Primitives `scroll` + `evaluate` | `getFollowingList()` workflow |
| 获取用户推文 | 复用 timeline 提取逻辑 | `getUserTweets(handle, count)` workflow |
| ~~提取策略升级~~ | ~~已在 M1 完成~~ | Research spike 结论：GraphQL 拦截已在 M1 实现为主力提取策略，M2 无需升级 |

### 产品形态

对应 PRD 全部 4 个场景。用户可以说"帮我关注 Vitalik"、"看看 @elonmusk 最近发了什么"。完整的 Twitter 自动化工具。

### 对 M1 的零改动承诺

- Primitives 接口不改（只加实现）
- Matcher 接口不改（只往 matchers 对象里加规则）
- MCP Server 工具注册模式不改（只注册更多 tool）
- extractors.ts 的**接口**不变（输入参数 + 输出 `Tweet[]`）。`interceptRequest` 的调用时机（需在触发页面加载前注册）已在 M1 的 workflow 中处理

---

## M3："可靠地长期运行"

> 概要 — M2 完成后再出详细设计文档

### 新增能力

| 能力 | 依赖什么 | 新增内容 |
|------|---------|---------|
| Throttle 增强 | M1 throttle 架构 | 点击坐标抖动（±3px）、渐进式滚动、站点级频率控制 |
| Auth Guard 中间件化 | M1 的 `checkAuth()` 函数 | 将 M1 的显式调用改为自动中间件（避免每个 workflow 手动调用的重复代码和遗漏风险，小型结构重构，检测逻辑不变） |
| 错误处理增强 | M1 基础错误类型（3 个） | 新增 `RateLimited`、`NavigationFailed` + 所有错误增强为完整上下文（操作步骤、页面状态）+ 自动截图（复用 M1 已有的 `screenshot()` 原语）。每类错误明确标注**重试策略**：哪些在 Primitives 层内部重试、哪些直接抛给 caller（详见[技术架构设计 — 错误分类](../site-use-design.md)） |
| 反爬第 1 层增强 | M1 browser.ts | Canvas 指纹噪声（防跨站关联追踪）+ WebRTC 泄露防护（代理模式下防真实 IP 泄露） |
| 广告/追踪域名屏蔽 | M1 browser.ts | 站点级可选配置：通过 `page.setRequestInterception()` 屏蔽广告和追踪域名，减少页面加载时间和噪声 DOM（详见[技术架构设计 — 反爬体系](../site-use-design.md)） |
| 反爬第 3 层 | Sites 层 | 限流信号检测（429 / 验证码页面）→ 抛 `RateLimited`。Cloudflare 挑战处理 M3 不实现（Twitter 不使用 Cloudflare），扩展新站点时按需启用 |

### 产品形态

从"能用"变成"好用"。用户每天跑一次 timeline 采集不会被封号，出问题时 AI 能拿到清晰的错误信息做决策。

### 对 M1/M2 的零改动承诺

- Throttle 增强是内部策略变化，包装方式不变，workflow 不感知
- Auth Guard 中间件化是对 M1 `checkAuth()` 的小型结构重构（从显式调用改为自动触发），检测逻辑本身不变
- 错误类型扩充是继承关系，M1 已有的 `ElementNotFound`、`SessionExpired`、`BrowserDisconnected` 不改
- 反爬增强是 browser.ts 启动参数的增量添加

---

## M4："Twitter 改版也不怕"

> 概要 — M3 完成后再出详细设计文档

### 新增能力

| 能力 | 依赖什么 | 新增内容 |
|------|---------|---------|
| Fingerprint 层 | Primitives 的 `evaluate()` + `takeSnapshot()` | `fingerprint.ts`（采集 + 相似度匹配）+ `storage.ts`（SQLite，better-sqlite3） |
| CompositeMatcher | M1 的 Matcher 接口 | ARIA 优先 → 指纹 fallback，替换 ARIAMatcher |
| `ElementFoundByFallback` 错误 | M3 错误体系 | 新增错误类型，候选列表 + 置信度 |

### 产品形态

Twitter 改版导致 ARIA 匹配失败时，系统自动用历史指纹找到候选元素，报告给 AI 决策。从"坏了需要人修"变成"坏了能自己提方案"。

### 对 M1/M2/M3 的零改动承诺

- Matcher 接口 M1 就定好了，M4 只换实现（ARIAMatcher → CompositeMatcher）
- Workflow 通过 Matcher 接口调用，不感知底层是纯 ARIA 还是 ARIA + Fingerprint
- SQLite 存储路径在 `SITE_USE_DATA_DIR` 下，M1 的数据目录约定已预留位置
- auto_save（匹配成功时保存指纹）在 CompositeMatcher 内部完成，workflow 不需要显式调用

> 注意：架构设计文档中的 workflow 示例代码展示了 workflow 显式调用 `fingerprint.save()` / `fingerprint.relocate()`。里程碑设计改进了这一点 —— 将 fingerprint 操作封装在 CompositeMatcher 内部，使 workflow 代码更简洁且不依赖 Fingerprint 层。架构设计文档的示例应视为概念说明，实际实现以里程碑设计为准。

---

## 修订记录

- 2026-03-18：通过 brainstorming 会话创建里程碑拆解
  - 策略：按架构层自底向上，每个里程碑包装为独立产品
  - 定义 4 个里程碑：M1（Timeline）→ M2（完整 Twitter）→ M3（可靠性）→ M4（自愈）
  - M1 详细设计含 5 个能力
  - 可插拔组件：Matcher 接口、throttle 策略、Primitives 后端
  - 数据目录支持用户通过 `SITE_USE_DATA_DIR` 自定义
  - Fingerprint 层推迟到 M4（需要真实失败案例来验证）
- 2026-03-18：Spec review 修复
  - M1 新增 `SessionExpired` 和 `BrowserDisconnected` 基础错误类型（原先全部推迟到 M3）
  - M1 新增 `checkAuth()` 函数供 workflow 显式调用（M3 改为自动中间件，承认为小型结构重构）
  - M1 新增前置 research spike：验证 DOM/evaluate 提取策略可行性（已知风险）
  - M1 的 `User` 类型改为 `TweetAuthor`（完整 `User` 推迟到 M2 验证）
  - M1 新增 Primitives escape hatch `getRawPage(site)`
  - M1 新增 progress notification 支持（可选）
  - 明确 screenshot 工具的 `site` 参数默认行为
  - 明确 M4 的 CompositeMatcher 封装是对架构设计 workflow 示例的改进
- 2026-03-18：新增设计决策追溯 + M1-M4 补充
  - 新增"关键设计决策追溯"章节（架构选择及理由、与 devtools-mcp 有意差异、排除决策、模块边界原则、反爬三层体系总览、待解决问题追踪）
  - M1 能力 2：补充 uid 生命周期规则（evaluate/snapshot/click 交互约束）
  - M1 能力 3：Mutex 补充 WHY（浏览器状态一致性）
  - M1 能力 4：checkAuth() 明确文件归属、补充"只检测不恢复"设计理由、错误携带基础上下文
  - M1 Research Spike：扩展验证范围（增加 JS 状态对象和 GraphQL 方案评估）
  - M2：提取策略展开为 4 种选项；零改动承诺修正 extractor 调用时机可能微调
  - M3：错误处理补充截图复用说明；反爬补充 Cloudflare scope boundary；Auth Guard 补充 WHY
  - 避免返工表：Primitives 行补充具体原语列表；错误类型行补充基础上下文；Matcher 行补充接口定义备注
  - M3 ASCII 图补全（Auth Guard + 错误处理）
- 2026-03-19：整合 Firecrawl 对比分析的借鉴项
  - 模块边界原则新增第 5 条：外部页面内容不可信（F1 对抗性文本防护）
  - M1 前置 research spike 引用 F9 新站点接入决策流程，产出格式对齐策略决策记录模板
  - M1 能力 4 新增"LLM 兜底路径的架构预留"：显式引用并解释 R1（extractor 接口不暴露策略）、R2（清洗层独立性）、R3（Zod 单一 schema 来源）
  - M3 错误处理增强引用 F7：每类错误明确标注重试策略（可重试 vs 不可重试）
  - M3 新增 F8：广告/追踪域名屏蔽作为站点级可选配置
- 2026-03-19：去重重构——将与设计文档重复的内容替换为引用
  - "架构选择及理由"表格：移除"理由"列，仅保留决策→里程碑映射
  - "与 devtools-mcp 有意差异"、"排除决策"、"模块边界原则"：替换为指向设计文档的引用
  - "新站点接入决策流程 + 站点分类矩阵"：替换为指向设计文档的引用
  - "提取策略栈"表格：简化为策略→里程碑映射，R1/R2/R3 详情指向设计文档
  - 对比文档的直接引用改为指向设计文档（设计文档已包含内联来源引用）
- 2026-03-19：整合 ScrapeGraphAI 对比分析的借鉴项
  - 待解决问题 #1 更新：提取策略从 4 种扩展为 5 层策略栈（新增 LLM 兜底作为第 5 层）
  - M1 能力 4 新增"提取策略栈"表格：定义 5 层策略的优先级、延迟、成本、触发条件和里程碑归属
  - M1 前置 research spike 新增"新站点接入决策流程"：LLM POC → 三步验证 → ARIA 评估 → 按站点分类矩阵选择长期方案
  - 新增站点分类矩阵：按"调用频率 × ARIA 支持"四象限决定提取策略（高频+ARIA好 → 确定性；低频+ARIA差 → LLM 长期方案）
- 2026-03-19：Research spike 完成——Twitter 提取策略确定为 GraphQL 拦截
  - `interceptRequest` 从 M2 提前到 M1（Primitives 实现 7/8 原语）
  - M1 提取策略：主力 GraphQL 拦截（策略栈第 1 层），降级 DOM 解析（策略栈第 3 层）
  - M2 Primitives 补全范围缩小：仅 `type(uid, text)`
  - 提取策略栈表格更新：第 1 层归属 M1，第 2 层标记为 Twitter 不可用
