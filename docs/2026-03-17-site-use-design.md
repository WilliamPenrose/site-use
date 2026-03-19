# site-use 技术架构设计

> 更新时间：2026-03-19
> 状态：设计已确认，待编写实施计划

## 概述

site-use 是一个站点级浏览器自动化工具，通过确定性 workflow 操控 Chrome，让 AI 专注于内容理解而非页面操作。

本文档定义 MVP 的技术架构，范围对应 [PRD](prd.md) 中的 4 个场景：首次使用、关注 KOL、每日简报、按需深挖。

---

## 整体架构

### 分层架构

```
┌──────────────────────────────────────────────────┐
│  MCP Client（Claude / OpenClaw Skill / Cursor）    │
└─────────────────────┬────────────────────────────┘
                      │ MCP Protocol（stdio）
┌─────────────────────▼────────────────────────────┐
│  MCP Server 进程（常驻，持有浏览器连接）              │
│  ├─ MCP 工具注册（高层业务工具）                     │
│  ├─ 浏览器生命周期管理（启动/连接/断线重连）         │
│  ├─ Mutex 串行化工具调用                            │
│  └─ 路由到对应站点适配层                            │
├──────────────────────────────────────────────────┤
│  Sites 层（站点适配）                               │
│  └─ twitter/                                      │
│      ├─ matchers.ts — 语义匹配规则（role + name）  │
│      ├─ workflows.ts — follow/search/timeline 等   │
│      └─ extractors.ts — 内容提取                   │
├──────────────────────────────────────────────────┤
│  Fingerprint 层 ┐  Primitives 层                   │
│  （元素指纹 +   │  （浏览器操作原语，               │
│   自适应重定位） │   对齐 devtools-mcp）             │
│                 │                                  │
│  fingerprint.ts │  primitives.ts — 工具接口定义     │
│  storage.ts     │  puppeteer-backend.ts — 当前实现  │
│  （SQLite）     │  throttle.ts — 操作节奏控制       │
│                 │  auth-guard.ts — 登录态检测       │
├─────────────────┴────────────────────────────────┤
│  ↑ Sites 层同时调用 Fingerprint 和 Primitives，    │
│    两者平级，互不依赖                               │
├──────────────────────────────────────────────────┤
│  Browser 层（浏览器生命周期）                        │
│  └─ browser.ts — 启动 Chrome（独立 profile、       │
│                  去掉 automation 标志、调试端口）     │
└──────────────────────────────────────────────────┘
          │ Puppeteer + CDP
┌─────────▼────────────────────────────────────────┐
│  Chrome（独立 profile，用户已登录 Twitter）          │
└──────────────────────────────────────────────────┘
```

### Primitives 层：与 devtools-mcp 同构

Primitives 层是 site-use 与 chrome-devtools-mcp 的对齐层。接口命名、参数结构、返回值语义**完全对齐** devtools-mcp 的工具定义，使得：

1. **开发时**：遇到接口设计疑问，直接参考 devtools-mcp 源码作为权威答案
2. **运行时**：当前用 `puppeteer-backend.ts` 直接执行（进程内调用，零序列化开销）
3. **未来切换**：如果用户已经跑了 devtools-mcp，可以写一个 `devtools-mcp-backend.ts`（MCP client 适配器）替换底层，上层 workflows 零改动

```
Primitives 接口（primitives.ts）
    │
    ├─ puppeteer-backend.ts  ← 当前：Puppeteer 进程内执行
    │
    └─ devtools-mcp-backend.ts  ← 未来：MCP client 调用已有 devtools-mcp 服务
```

**为什么不直接用 devtools-mcp**：不希望让用户搞出两套 MCP 服务。site-use 用 Puppeteer 直接执行相同语义的操作，对用户来说只有一个进程。

#### 核心原语（对齐 devtools-mcp 工具）

| site-use 原语 | devtools-mcp 工具 | 说明 |
|---------------|-------------------|------|
| `navigate(url)` | `navigate_page` | 导航 + 等待加载 |
| `takeSnapshot()` | `take_snapshot` | 获取辅助功能树，返回结构化 JSON（role/name/uid） |
| `click(uid)` | `click` | 通过 snapshot uid 点击元素 |
| `type(uid, text)` | `type` | 通过 snapshot uid 定位 + 逐字输入 |
| `scroll(options)` | `scroll` | 滚动页面 |
| `evaluate(fn)` | `evaluate_script` | 执行 JS，用于只读数据提取 |
| `interceptRequest(pattern, handler)` | — | 拦截匹配 URL 模式的网络请求/响应，用于 GraphQL 等 API 数据提取 |
| `screenshot()` | `screenshot` | 截图（调试用） |

#### 元素定位：snapshot uid，非 CSS 选择器

与 devtools-mcp 一致，所有元素交互通过 **snapshot uid** 定位，不再使用 CSS 选择器：

1. `takeSnapshot()` 返回辅助功能树 JSON（包含 `idToNode` 映射）
2. 每个节点有 `uid`、`role`（ARIA role）、`name`（无障碍名称）等属性
3. `click(uid)` / `type(uid, text)` 通过 uid 操作元素

**uid 生命周期**：每次 `takeSnapshot()` 刷新。只读的 `evaluate()` 不会使 uid 失效（只要不修改 DOM），但 DOM 变化后需要重新 take snapshot。

**evaluate 与 snapshot/click 的混合使用**：`evaluate` 操作 CDP Runtime 域，`click`/`type` 操作无障碍树 uid → Puppeteer Locator，两者走不同 CDP 路径，可以自由混合。但 `takeSnapshot()` 应在 `evaluate()` **之后**调用，确保拿到最新状态。典型模式：`evaluate`（读数据做业务决策）→ `takeSnapshot`（获取最新辅助功能树）→ `click(uid)`（操作）。

**Puppeteer 实现**：`puppeteer-backend.ts` 内部通过 Puppeteer 的 CDP Accessibility 域获取辅助功能树，构建 uid 映射，然后通过 backend node ID 定位元素执行操作。这与 devtools-mcp 的内部实现路径一致。

### 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 对外接口 | MCP Server（标准 MCP 协议） | 与 devtools-mcp 同类；agent 天然支持；无需自定义 IPC 协议 |
| 浏览器控制 | Puppeteer + CDP 直连，不经过外部 MCP 服务 | 不让用户跑两套 MCP 服务；通过 Primitives 层对齐 devtools-mcp 接口，未来可切换 |
| Chrome 启动 | site-use 负责启动（指定独立 profile + 调试端口） | 用户不需要手动配置 Chrome |
| 进程模型 | MCP Server 常驻进程，持有浏览器连接 | 与 devtools-mcp 进程模型一致 |
| 元素定位 | snapshot uid（ARIA 语义匹配 + 指纹 fallback），对齐 devtools-mcp | ARIA 为主（比 CSS 更抗改版），指纹相似度为辅（自动降级保护网）；与 devtools-mcp 同构 |
| 首次使用编排 | 属于 caller（Skill）的职责，不属于 site-use | site-use 提供原子能力（`check-login`、`following-list`）；Skill 编排"启动 → 等待登录 → 获取列表 → 询问用户"的完整流程 |
| KOL 列表 | 不做本地缓存，按需从 Twitter 实时获取 | Timeline 本身就是已关注用户内容的聚合流；following 列表仅用于元信息 |
| 内容提取 | 策略实现时研究决定 | 需要研究 Twitter 前端实现（GraphQL 拦截 vs DOM 解析 vs JS 状态对象）；设计上将 extractors 和 selectors 分离 |
| 架构演进 | 四层：Sites + Fingerprint + Primitives + Browser；Primitives 对齐 devtools-mcp | Fingerprint 和 Primitives 平级，都被 Sites 层调用；未来可切换到 devtools-mcp 后端；做完 2-3 个站点后再提炼声明式引擎 |
| 实现语言 | TypeScript（不用 Go） | Puppeteer 是 Node.js 原生库，整个 Primitives 层围绕 Puppeteer 设计；与 devtools-mcp 同语言，可直接参考/复用代码；MCP SDK（`@modelcontextprotocol/sdk`）成熟。用 Go 则需换 Rod，API 模型不同，与 devtools-mcp 同构设计断裂。参考：xiaohongshu-mcp 用 Go + Rod，但其进程模型不同（每次启动新 Chrome 再杀掉），不需要 Puppeteer 的常驻连接能力 |

---

## MCP Server

### 与 devtools-mcp 的关系

site-use 本身就是一个 MCP server，与 devtools-mcp 是**同类东西**——进程模型、浏览器管理、并发控制完全一致。区别仅在暴露的工具粒度：

```
devtools-mcp 暴露：navigate_page, click, type, take_snapshot, ...（低层原语，35+ 工具）
site-use 暴露：  twitter_timeline, twitter_follow, ...（高层业务工具，~8 个）
```

Primitives 层不暴露给 MCP client，只在 server 内部使用。对 agent 来说，site-use 是一个"已经会操作 Twitter 的 devtools-mcp"。

### 与 devtools-mcp 的有意差异

以下差异是经过设计考虑后有意选择的简化，不是遗漏：

| 方面 | devtools-mcp | site-use | 理由 |
|------|-------------|----------|------|
| 工具粒度 | 35+ 低层浏览器原语 | ~8 个高层业务工具 | agent 不需要操心浏览器操作细节 |
| 状态持有 | McpContext 单例（内含 Browser + McpPage + PageCollector） | Browser 单例 + `Map<site, Page>` | 不需要通用 page 生命周期管理，少一层抽象 |
| 多页面 | 通用 page ID 切换（create/switch/close） | 按站点固定映射，自动路由 | workflow 知道自己操作哪个站点，不需要通用切换 |
| Context Layer | McpContext → McpPage → Mutex | 无，Mutex 直接在 MCP Server 层 | 没有 PageCollector 事件收集需求，不需要中间层 |
| 遥测 | Google Clearcut | 无 | 非 Google 项目，不需要 |
| 扩展管理 | install / uninstall / trigger | 无（MVP 手动安装，未来可同步主 profile 扩展） | MVP 不需要，列入待解决问题 |
| Chrome 连接 | 连接用户已打开的 Chrome | 启动独立 Chrome 实例（专用 profile） | 沙盒隔离，不影响用户日常浏览 |

### 职责

- 注册并暴露高层业务 MCP 工具
- 持有 Puppeteer 浏览器连接（模块级单例）
- 管理浏览器生命周期（启动、检测断线、重连）
- 通过 Mutex 串行化所有工具调用（与 devtools-mcp 一致）

### 传输方式

使用 `@modelcontextprotocol/sdk` 的 `StdioServerTransport`，MCP client 通过 stdio 管道通信。这是 MCP 的标准传输方式，所有主流 MCP client（Claude Desktop、Cursor、VS Code 等）天然支持。

MCP client 配置示例：
```json
{
  "mcpServers": {
    "site-use": {
      "command": "npx",
      "args": ["site-use"]
    }
  }
}
```

### 工具注册

每个 workflow 注册为一个 MCP tool，使用 Zod schema 定义参数：

```typescript
server.registerTool('twitter_timeline', {
  description: 'Get tweets from Twitter timeline',
  inputSchema: z.object({
    count: z.number().optional().default(50),
  }),
  handler: async (params) => {
    const result = await twitterWorkflows.getTimeline(params.count);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  },
});
```

### MVP 工具清单

| MCP Tool | 对应 workflow | 输入参数 | 返回 |
|----------|--------------|----------|------|
| `twitter_check_login` | `checkLogin()` | 无 | `{ loggedIn: boolean }` |
| `twitter_following_list` | `getFollowingList()` | 无 | `User[]` |
| `twitter_search_user` | `searchUser(query)` | `{ query: string }` | `UserCandidate[]` |
| `twitter_follow` | `followUser(handle)` | `{ handle: string }` | `{ success: boolean }` |
| `twitter_timeline` | `getTimeline(count)` | `{ count?: number }` | `Tweet[]` + `TimelineMeta` |
| `twitter_user_tweets` | `getUserTweets(handle, count)` | `{ handle: string, count?: number }` | `Tweet[]` |
| `screenshot` | Primitives `screenshot()` | `{ site?: string }` | `ImageContent`（base64 PNG） |

### 状态机

```
         MCP Client 连接
              │
              ▼
┌─────────────────────────┐
│    无浏览器（IDLE）       │ ←── Chrome 被用户关闭
│                         │ ←── 连接断开（崩溃/休眠）
└────────────┬────────────┘
             │ 收到第一个 tool call
             │ → 启动 Chrome（指定 profile + 调试端口）
             │ → Puppeteer 连接
             ▼
┌─────────────────────────┐
│    已连接（ACTIVE）       │ ←── 正常服务状态
│                         │     执行 workflow，返回结果
└────────────┬────────────┘
             │ MCP Client 断开连接
             ▼
┌─────────────────────────┐
│    Server 退出            │
│    （不关闭 Chrome）       │
└─────────────────────────┘
```

### 关键行为

- **Lazy Chrome**：第一个需要浏览器的 tool call 才启动 Chrome，不是 server 启动时就启动
- **断线恢复**：每次执行 tool call 前检查 `browser.connected`，断了就重新启动 Chrome
- **不关闭 Chrome**：server 退出时不关闭 Chrome（Chrome 是用户可见的窗口，由用户决定何时关闭）
- **串行执行**：所有 tool call 通过 Mutex 串行化，与 devtools-mcp 一致，保证浏览器状态一致性

---

## Primitives 层

Primitives 层封装跨站点的通用浏览器操作原语，接口**完全对齐 chrome-devtools-mcp 的工具定义**。站点适配层只通过 Primitives 操作，不直接调 Puppeteer。

### primitives.ts — 接口定义

定义所有原语的 TypeScript 接口。命名、参数、返回值语义对齐 devtools-mcp，遇到设计疑问直接参考 devtools-mcp 源码。

| 原语 | 对齐 devtools-mcp | 说明 |
|------|-------------------|------|
| `navigate(url)` | `navigate_page` | 导航 + 等待加载完成 |
| `takeSnapshot()` | `take_snapshot` | 获取辅助功能树 JSON（idToNode 映射，含 uid/role/name） |
| `click(uid)` | `click` | 通过 snapshot uid 点击 + 等待 DOM 稳定 |
| `type(uid, text)` | `type` | 通过 snapshot uid 定位 + 逐字输入 |
| `scroll(options)` | `scroll` | 滚动页面（方向、距离、次数）|
| `evaluate(fn)` | `evaluate_script` | 执行 JS 表达式（用于只读数据提取） |
| `interceptRequest(pattern, handler)` | — | 拦截匹配 URL 模式的网络请求/响应，用于 GraphQL 等 API 数据提取 |
| `screenshot()` | `screenshot` | 截图（调试用） |

每个原语自动经过 throttle 层。`interceptRequest` 是 site-use 扩展的原语（受 [xiaohongshu-mcp 的 `__INITIAL_STATE__` 提取模式](comparisons/site-use-vs-xiaohongshu-mcp-comparison.md#内容获取)启发），devtools-mcp 没有对应工具——devtools-mcp 通过 `network_enable` + `network_get_log` 被动收集网络日志，而 `interceptRequest` 是主动拦截模式，更适合精确提取特定 API 响应（如 Twitter GraphQL、小红书 API）。

### puppeteer-backend.ts — 当前实现

用 Puppeteer 进程内执行 Primitives 接口：

- **takeSnapshot()**：通过 CDP `Accessibility.getFullAXTree` 获取辅助功能树，构建 uid → backend node ID 映射
- **click(uid) / type(uid, text)**：通过 uid 查找 backend node ID → CDP `DOM.resolveNode` → Puppeteer Locator 操作
- **navigate(url)**：Puppeteer `page.goto()` + 等待 load 事件
- **evaluate(fn)**：Puppeteer `page.evaluate()`
- **interceptRequest(pattern, handler)**：Puppeteer `page.on('response')` + URL 模式匹配，拦截到匹配的响应后调用 handler 处理。典型用法：extractors.ts 注册拦截 `*/i/api/graphql/*`，workflow 触发页面加载/滚动，拦截器自动捕获 API 响应并解析为结构化数据
- 其余原语类似，均为 Puppeteer API 的薄封装

参考 devtools-mcp 的内部实现路径：snapshot → uid → backend node ID → DOM resolve → 操作。

#### 多页面管理

持有 `Map<site, Page>` 映射，每个站点一个 tab，lazy 创建：

```
Browser 单例
  ├─ twitter page（导航到 x.com 的 tab）
  └─ reddit page（导航到 reddit.com 的 tab）
```

- **Lazy 创建**：第一次调某个站点的 tool 时 `browser.newPage()` 并缓存
- **自动路由**：workflow 调用 Primitives 时自动拿到自己站点的 page，对 MCP client 透明——调 `twitter_timeline` 自动用 twitter 的 tab，调 `reddit_hot` 自动用 reddit 的 tab
- **状态保留**：切换站点操作时，之前站点的 tab 保持打开，页面状态（登录态、滚动位置等）不丢失，避免重复导航
- **串行执行**：全局 Mutex 不变，同一时刻只操作一个 tab，与 devtools-mcp 一致

不需要 devtools-mcp 那套完整的 Context Layer（McpContext / McpPage / PageCollector）——没有通用的 page ID 切换机制，没有 PageCollector 事件收集，只是一个简单的 site → page 映射。

### 未来：devtools-mcp-backend.ts

如果用户已经跑了 chrome-devtools-mcp 服务，可以写一个 MCP client 适配器实现同一 Primitives 接口，直接转发到 devtools-mcp。上层 workflows 零改动。

### browser.ts — 浏览器管理

启动 Chrome 的参数：
- `--user-data-dir=<专用 profile 目录>` — 独立 profile，保持登录态
- `--remote-debugging-port=<随机端口>` — CDP 连接，避免默认 9222 以降低端口探测风险
- `--proxy-server=<proxy>` — 当配置了代理时，通过 Chrome 启动参数注入（见下方代理支持）
- 去掉 `--enable-automation` 标志 — 防止 `navigator.webdriver=true`
- `--fingerprinting-canvas-image-data-noise` — Canvas 指纹噪声，防止跨站关联追踪（详见反爬策略第 1 层）
- `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy` — 仅在配置了代理时添加，防止 WebRTC 泄露真实 IP（详见反爬策略第 1 层）
- 非 headless — 用户需要看到操作过程（这是产品特性，不是技术限制）
- 使用用户本地安装的 Chrome，不用 Puppeteer 自带的 Chromium — 通过 Puppeteer 的 `channel: 'chrome'` 选项自动发现各平台的 Chrome 路径

**代理支持**（参考 [xiaohongshu-mcp 的 `XHS_PROXY` 模式](comparisons/site-use-vs-xiaohongshu-mcp-comparison.md#site-use-从-xiaohongshu-mcp-采纳的)）：通过环境变量 `SITE_USE_PROXY` 配置 HTTP/SOCKS5 代理（如 `http://127.0.0.1:7890`、`socks5://127.0.0.1:1080`）。设置后，browser.ts 在启动 Chrome 时添加 `--proxy-server` 参数。这对访问 Twitter 等需要代理的站点至关重要。如果代理需要认证，通过 Puppeteer 的 `page.authenticate({ username, password })` 处理（用户名密码从 `SITE_USE_PROXY_USER` / `SITE_USE_PROXY_PASS` 环境变量读取）。

参考 Chrome DevTools MCP 的 `browser.ts` 实现：
- 连接建立流程（wsEndpoint、browserURL、DevToolsActivePort 文件）
- 浏览器实例缓存（模块级单例）
- 断线检测

### throttle.ts — 操作节奏控制

包装在 Primitives 原语之上，所有操作经过统一节流（参考 [xiaohongshu-mcp 对比分析](comparisons/site-use-vs-xiaohongshu-mcp-comparison.md#反检测)）：
- 操作间随机延迟（可配置范围，默认 1-3 秒）
- 渐进式滚动（不瞬间跳到底部）
- 逐字输入（Puppeteer Locator 已内置支持）
- 点击坐标抖动（±3px 随机偏移，模拟真人手指不精准）

throttle 在 Primitives 层实现，意味着无论底层是 Puppeteer 还是 devtools-mcp 后端，都有节奏保护。站点适配层可以覆盖默认节奏参数。

### auth-guard.ts — 登录态检测

统一的登录态检查，workflow 执行前自动触发：
- 检测策略由站点适配层配置（如 Twitter 提供"检查是否被重定向到登录页"的逻辑）
- 检测到未登录 → 抛出 `SessionExpired` 错误，由 caller 处理
- Primitives 层不做登录恢复 — 恢复策略属于 caller（Skill 有 AI 能力和用户上下文）

### 模块边界原则

1. Primitives 层**不知道**任何站点的具体细节（没有 Twitter 的 URL 或语义匹配规则）
2. 站点适配层**不直接调** Puppeteer API，只通过 Primitives 接口操作
3. Escape hatch：如果某个操作太特殊、Primitives 覆盖不了，站点适配层可以拿到底层 Page 对象——但这是例外不是常态
4. **外部页面内容不可信** — 任何将页面内容传给 LLM 的路径（如 LLM 兜底提取），必须在 system prompt 中加入对抗性文本防护（prompt injection 防御）。页面内容来自不受信任的外部网站，可能嵌入伪装成指令的对抗性文本（来源：[Firecrawl 对比分析 §4.3](comparisons/site-use-vs-firecrawl-comparison.md#43-prompt-工程)）

---

## Fingerprint 层

Fingerprint 层与 Primitives 层平级，都被 Sites 层调用。负责元素指纹的采集、持久化和相似度重定位（整体设计参考 [Scrapling 对比分析 §1.2 元素指纹系统](comparisons/site-use-vs-scrapling-comparison.md#12-scrapling-的元素指纹系统重点剖析)）。

### fingerprint.ts — 元素指纹采集 + 相似度匹配

#### 数据源：辅助功能树 + DOM 补充

指纹采集需要两种数据源：

1. **辅助功能树**（来自 `takeSnapshot()`）：role、name、uid、层级关系——这是 ARIA 匹配的同一棵树，零额外成本
2. **DOM 属性**（通过 `evaluate()` 按需获取）：tag、class、id、href、text content、DOM 路径（祖先标签序列）、父/兄弟/子元素特征

为什么需要 DOM 补充：辅助功能树是 DOM 的精简投影，很多元素在辅助功能树中不可见或被合并。当 ARIA 匹配失败需要 fallback 时，说明辅助功能树已经不够用了——必须回到 DOM 层面做更细粒度的比对。

#### 指纹数据结构

```typescript
interface ElementFingerprint {
  // 来自辅助功能树
  role: string;           // ARIA role
  name: string;           // accessible name
  // 来自 DOM（evaluate 获取）
  tag: string;            // HTML tag name
  attributes: Record<string, string>;  // class, id, href, src 等
  textContent: string;    // 直接文本内容
  domPath: string[];      // 祖先标签序列，如 ['html', 'body', 'main', 'div', 'button']
  parent: { tag: string; attributes: Record<string, string> };
  siblings: string[];     // 兄弟元素标签列表
  children: string[];     // 子元素标签列表
}
```

#### 核心接口

```typescript
// 保存元素指纹（ARIA 匹配成功时调用）
fingerprint.save(matcherName: string, uid: string, snapshot: Snapshot): Promise<void>
// 内部：通过 uid 定位 DOM 元素 → evaluate() 采集 DOM 属性 → 与辅助功能树属性合并 → 写入 SQLite

// 重定位元素（ARIA 匹配失败时调用）
fingerprint.relocate(matcherName: string, snapshot: Snapshot): Promise<Candidate[]>
// 内部：从 SQLite 读取旧指纹 → evaluate() 遍历页面 DOM 元素 → 逐一计算相似度 → 返回排序后的候选列表

interface Candidate {
  uid: string;            // 辅助功能树中的 uid（如果有对应节点）
  domSelector: string;    // CSS 选择器（fallback 定位用）
  score: number;          // 0-1 相似度得分
  fingerprint: ElementFingerprint;  // 候选元素的指纹（供 caller 审查）
}
```

#### 相似度算法

借鉴 [Scrapling 的 `__calculate_similarity_score`](comparisons/site-use-vs-scrapling-comparison.md#12-scrapling-的元素指纹系统重点剖析)，对每个维度独立计算 0-1 相似度，取加权平均：

| 维度 | 权重 | 计算方式 |
|------|------|---------|
| tag 名 | 1.0 | 完全匹配 0/1 |
| text content | 1.0 | SequenceMatcher ratio |
| attributes（除 class/id） | 0.5 key + 0.5 value | 字典相似度 |
| class | 1.0 | token 集合交集比 |
| id | 1.0 | SequenceMatcher ratio |
| DOM path | 1.0 | SequenceMatcher ratio on path array |
| parent 特征 | 0.5 | tag + attributes 综合 |
| siblings | 0.5 | 标签列表 SequenceMatcher |

默认接受阈值：0.6（可配置）。

### storage.ts — SQLite 持久化

- 使用 `better-sqlite3`（同步 API，无需 async 开销）
- 数据库文件存放在 site-use 数据目录下（与 Chrome profile 同级）
- 按域名分表：`fingerprints_twitter`、`fingerprints_reddit` 等
- 每条记录：`matcher_name`（主键）+ `fingerprint_json` + `updated_at`
- 每次 `save()` 是 upsert——同一 matcher 只保留最新指纹
- 对用户零感知，不需要任何配置

---

## 站点适配层：Twitter

### matchers.ts — 语义匹配规则

替代原来的 selectors.ts。不再使用 CSS 选择器，改用**辅助功能树语义匹配**（对齐 devtools-mcp 的 snapshot uid 机制）。

每条匹配规则定义 `role` + `name`（及可选的上下文约束），用于从 `takeSnapshot()` 返回的辅助功能树中确定性地定位目标元素：

```typescript
// matchers.ts — 所有 Twitter 语义匹配规则集中在此文件
export const matchers = {
  followButton:    { role: 'button', name: /^Follow$/i },
  unfollowButton:  { role: 'button', name: /^Following$/i },
  tweetTextbox:    { role: 'textbox', name: /post/i },
  searchInput:     { role: 'combobox', name: /search/i },
  // ...
} as const;
```

**Workflow 中的使用**（参考知识库中的[混合架构：确定性流程 + AI 降级](../../knowledge/cdp/chrome-devtools-mcp-client-guide.md)）：

```typescript
// workflows.ts 中的典型操作路径
const snapshot = await primitives.takeSnapshot();
const uid = matchByRule(snapshot, matchers.followButton);
if (uid) {
  await fingerprint.save('followButton', uid, snapshot); // auto_save
  await primitives.click(uid);
} else {
  // ARIA 匹配失败，尝试指纹 fallback
  const candidates = await fingerprint.relocate('followButton', snapshot);
  if (candidates.length > 0) {
    throw new ElementFoundByFallback('followButton', candidates, snapshot);
    // caller（Skill/AI）评估候选置信度，决定是否采用
  }
  throw new ElementNotFound('followButton', snapshot);
}
```

**为什么比 CSS 选择器更稳定**：网站改版通常改 CSS 类名和 DOM 结构，但无障碍属性（`role="button"`、`name="Follow"`）一般不变——改了会破坏无障碍合规，网站通常不会轻易改动。

**匹配规则主要服务于操作**（点击、输入、滚动定位）。内容提取可能完全不依赖语义匹配（见 extractors.ts）。

**双层匹配策略：ARIA 语义 + 指纹 Fallback**

```
ARIA 匹配（matchers.ts）
    │
    ├─ 匹配成功 → 执行操作 + 顺手保存元素指纹到 SQLite（auto_save）
    │
    └─ 匹配失败（ElementNotFound）
        │
        └─ 指纹 Fallback（fingerprint.ts）
            ├─ 从 SQLite 读取该元素之前保存的多维指纹
            ├─ 遍历当前页面元素，计算相似度得分
            └─ 返回候选列表 + 置信度 → caller（Skill/AI）决定是否采用
```

- **auto_save**：每次 ARIA 匹配成功时，workflow 调用 `fingerprint.save()`，内部通过 `evaluate()` 采集 DOM 属性（tag、class、id、DOM 路径等），与辅助功能树属性（role、name）合并后写入 SQLite。详见 Fingerprint 层章节
- **指纹相似度匹配**：借鉴 [Scrapling 的 `relocate` 算法](comparisons/site-use-vs-scrapling-comparison.md#12-scrapling-的元素指纹系统重点剖析)——对每个维度用 SequenceMatcher 计算 0-1 相似度，取加权平均。返回得分最高且 ≥ 阈值的候选元素
- **契合"检测不恢复"哲学**：fallback 不自动采用候选，而是返回候选列表 + 置信度，由 caller 决定。这与 site-use 的错误处理设计一致
- **存储**：`better-sqlite3`，按域名分表，本地文件，对用户零感知。详见 Fingerprint 层的 storage.ts 章节

**维护策略**：匹配规则集中在一个文件；`ElementNotFound` 错误包含哪条规则匹配失败 + 当前 snapshot 摘要 + 指纹 fallback 候选列表（如果有历史指纹）；Twitter 改版时只改 matchers.ts，指纹 fallback 作为自动降级保护网。

### workflows.ts — 原子操作

每个 workflow 是一个函数，组合 core 层原语：

| Workflow | PRD 场景 | 输入 | 输出 |
|----------|----------|------|------|
| `checkLogin()` | 所有场景 | 无 | `{ loggedIn: boolean }` |
| `getFollowingList()` | 场景 0 | 无 | `User[]` |
| `searchUser(query)` | 场景 1 | 人名或 handle | `UserCandidate[]` |
| `followUser(handle)` | 场景 1 | Twitter handle | `{ success: boolean }` |
| `getTimeline(count)` | 场景 2 | 条数 | `Tweet[]` + `TimelineMeta` |
| `getUserTweets(handle, count)` | 场景 3 | handle + 条数 | `Tweet[]` |

**TimelineMeta**（`getTimeline` 返回，满足 PRD 的覆盖面透明度要求）：
```
{
  tweetCount: number          // 采集的推文总数
  coveredUsers: string[]      // 本次采集中出现的用户 handle 列表
  coveredUserCount: number    // 本次覆盖的独立用户数
  timeRange: { from, to }    // 最早和最晚推文的时间戳
}
```
Caller 可以将 `coveredUsers` 与 following 列表对比，识别被 Twitter 算法过滤掉的 KOL，按需调用 `getUserTweets` 补采。

每个 workflow 内部：
1. auth-guard 检查登录态
2. 导航到目标页面
3. `takeSnapshot()` 获取辅助功能树
4. 用 matchers.ts 规则匹配目标元素 uid
5. 匹配成功 → auto_save 元素指纹到 SQLite；匹配失败 → 调用 fingerprint fallback，返回候选列表 + 置信度（由 caller 决定是否采用）
6. 通过 uid 执行操作序列（click/type/scroll）
7. 提取内容（evaluate 或再次 snapshot）
8. 返回结构化数据

**uid 与 evaluate 的交互规则**：
- DOM 变化（如 click 后页面更新）会使之前的 uid 失效，需要重新 `takeSnapshot()`
- 只读的 `evaluate()` 不修改 DOM，不会使 uid 失效，可以和 click/type 自由混合（走不同 CDP 路径）
- 如果 workflow 需要先用 `evaluate()` 读数据做决策再操作，应按 `evaluate` → `takeSnapshot` → `click(uid)` 的顺序，确保 snapshot 拿到最新状态

**Workflow 是原子的** — 只做浏览器操作和数据提取，不做 AI 分析。分析属于上层 Skill。

**深挖策略（场景 3）**：site-use 不需要 `getTweetDetail(tweetId)` 这样的 workflow。`getTimeline` 输出已包含完整推文文本 + 原文链接。Skill 层处理深挖：(1) 在已采集数据中查找对应推文，(2) 向用户提供原文和链接，(3) 用 LLM 展开讨论。如果用户想看某人的完整 timeline，Skill 调用 `getUserTweets`。

### extractors.ts — 内容提取

独立于选择器的模块。每个站点的提取策略在接入前通过 research spike 确定（见新站点接入决策流程章节），之后固化为 workflow 代码，运行时不再决策。

#### 提取策略栈

extractor 内部按优先级依次尝试，对 workflow 透明：

| 层 | 策略 | 延迟 | 成本 | 触发条件 |
|----|------|------|------|----------|
| 1 | GraphQL / API 拦截（`interceptRequest`） | <50ms | $0 | 站点有可拦截的结构化 API |
| 2 | JS 状态对象（`evaluate`） | <50ms | $0 | `window.__INITIAL_STATE__` 等全局对象可用 |
| 3 | ARIA 语义匹配 + DOM 解析 | <100ms | $0 | ARIA 属性完善的站点 |
| 4 | Fingerprint 相似度重定位 | <200ms | $0 | ARIA 匹配失败，有历史指纹 |
| 5 | LLM 兜底提取 | 3-8s | ~$0.06/次 | 前 4 层全部失败，或低频+ARIA差的站点作为长期方案 |

每个站点的 research spike 决定从哪层开始（见新站点接入决策流程章节）。不是所有站点都需要实现全部 5 层——高频站点用确定性策略（第 1-4 层），低频+ARIA 差的站点可以永久停在 LLM 提取层（第 5 层），月成本可控且零维护（来源：[ScrapeGraphAI 对比分析 §5.4](comparisons/site-use-vs-scrapegraph-ai-comparison.md#54-长期架构判断)）。

参考：小红书自动化项目用 `window.__INITIAL_STATE__` 读取数据，用 CSS 选择器做写操作。Twitter 可能有类似模式。

#### LLM 兜底路径的架构预留

当前不写代码，确保设计不阻断未来路径（来源：[Firecrawl 对比分析 §8 架构预留](comparisons/site-use-vs-firecrawl-comparison.md#八总结可执行的借鉴清单)、[ScrapeGraphAI 对比分析 §5.3](comparisons/site-use-vs-scrapegraph-ai-comparison.md#53-具体建议)）：

- **R1：Extractor 接口不暴露提取策略** — extractor 对 workflow 暴露统一签名 `(page) => Promise<T[]>`，workflow 不关心内部是 DOM 解析、GraphQL 拦截还是 LLM 提取。原因：未来可能从 DOM 切换到 GraphQL 甚至 LLM 兜底，如果 workflow 依赖了具体策略（如调用时机、参数差异），每次切换都要改 workflow 代码。统一接口让策略切换对 workflow 零侵入。
- **R2：清洗层独立性** — extractors.ts 内部的 DOM 清洗逻辑（如有）应作为独立工具函数，不绑定在特定 extractor 内部。原因：确定性提取不需要清洗，但 LLM 兜底路径需要先清洗 HTML（去掉导航、广告、弹窗等噪声元素）再喂给 LLM，以减少 token 消耗（参考 [Firecrawl §3.4 清洗规则](comparisons/site-use-vs-firecrawl-comparison.md#34--对-site-use-的借鉴价值)）。两条路径应能独立调用同一个清洗函数。
- **R3：Zod 作为唯一 schema 来源** — `Tweet`、`User` 等业务类型用 Zod schema 定义（MCP SDK 的工具参数注册本身就依赖 Zod）。原因：未来 LLM 兜底提取需要把 schema 传给 LLM 做结构化输出（Zod schema → JSON Schema → LLM `generateObject()`，参考 [Firecrawl §4.3 Schema 注入](comparisons/site-use-vs-firecrawl-comparison.md#43-prompt-工程)），如果存在两套类型定义会导致不一致。保持 Zod 作为唯一来源，确保确定性路径和 LLM 路径产出完全一致的类型。

### 核心数据结构

**Tweet：**
```
{
  id: string              // 推文 ID（从链接提取）
  author: { handle, name }
  text: string
  timestamp: string       // ISO 8601
  url: string             // 推文原文链接
  metrics: { likes, retweets, replies }  // 尽力提取，可能不完整
  isRetweet: boolean
  isAd: boolean           // 广告标记，用于过滤
}
```

**User：**
```
{
  handle: string
  name: string
  bio: string
  followers: number
  avatarUrl: string
}
```

### Auth 配置

Twitter 适配层向 Primitives 的 auth-guard 提供检测逻辑：
- 检查当前 URL 是否包含 `/login` 或 `/i/flow/login`
- `takeSnapshot()` 后检查辅助功能树中是否存在只有登录用户才有的元素（如发推按钮，通过 matchers 规则匹配）

---

## 反爬策略

独立章节。MVP 先定框架和基本实现，后续专门深入。

### 三层体系

```
第 1 层：浏览器指纹
  └─ 启动时配置（一次性）

第 2 层：操作行为
  └─ throttle.ts 统一控制（运行时）

第 3 层：会话特征
  └─ 站点适配层处理（按站点不同）
```

### 第 1 层：浏览器指纹

让 site-use 启动的 Chrome 尽可能像正常用户的浏览器：
- 去掉 `--enable-automation` 标志（`navigator.webdriver=false`）
- 使用用户本地安装的 Chrome（不是 Puppeteer 自带的 Chromium）
- 独立 profile 在首次登录后自然积累 cookies/localStorage
- 随机 CDP 端口（不用默认 9222）以降低端口探测风险
- 代理支持（`SITE_USE_PROXY` 环境变量）— 对访问需要代理的站点（如 Twitter）至关重要，也可用于 IP 轮换
- **WebRTC 泄露防护**（代理模式下）：当配置了代理时，添加 `--webrtc-ip-handling-policy=disable_non_proxied_udp` + `--force-webrtc-ip-handling-policy`，防止 WebRTC 泄露用户真实 IP（参考 [Scrapling 对比分析 §2.2 S3](comparisons/site-use-vs-scrapling-comparison.md#24-对-site-use-的借鉴价值)）
- **Canvas 指纹噪声**：添加 `--fingerprinting-canvas-image-data-noise`，对 Canvas 操作注入随机噪声。真实 Chrome 的 Canvas 指纹是固定的，跨站点可以被关联追踪同一用户；注入噪声后每次会话的 Canvas 指纹不同，防止跨站关联。多账号场景下尤其重要（参考 [Scrapling 对比分析 §2.2 S5](comparisons/site-use-vs-scrapling-comparison.md#24-对-site-use-的借鉴价值)）

### 第 2 层：操作行为

core/throttle.ts，所有浏览器操作经过：
- 操作间随机延迟（可配置范围，默认 1-3 秒）
- 渐进式滚动（不瞬间跳到底部）
- 逐字输入（Puppeteer Locator 已内置支持）
- 点击坐标抖动（±3px 随机偏移，模拟真人手指不精准）

参考：[xiaohongshu-mcp](comparisons/site-use-vs-xiaohongshu-mcp-comparison.md#反检测) 用 300-1200ms 随机延迟 + ±3px 点击抖动 — 简单但有效。MVP 用类似方案。

### 第 3 层：会话特征

站点级反爬应对，由适配层处理：
- 站点级操作频率上限（如每分钟最多 N 次页面导航）
- 检测限流信号（HTTP 429、验证码页面）
- 检测到限流 → 抛出结构化错误，由 caller 决定是否等待重试
- **广告/追踪域名屏蔽**（站点级可选配置）：通过 `page.setRequestInterception()` 屏蔽广告和追踪域名（如 doubleclick.net、google-analytics.com 等），减少页面加载时间和噪声 DOM 元素（参考 [Firecrawl §5.2 请求过滤](comparisons/site-use-vs-firecrawl-comparison.md#52-firecrawl-的关键设计细节)）
- **Cloudflare 挑战处理**（可选中间件）：扩展到有 Cloudflare 防护的站点时启用。检测挑战类型（非交互式/管理式/交互式/嵌入式）→ 等待页面稳定（network idle）→ 模拟人类鼠标点击（100-200ms 随机延迟）→ 处理嵌入式 iframe 挑战 → 递归重试（参考 [Scrapling 对比分析 §2.2 S4](comparisons/site-use-vs-scrapling-comparison.md#24-对-site-use-的借鉴价值)）

### MVP 范围

MVP 实现第 1 层和第 2 层的基础。第 3 层只做检测（发现限流就报错），不做自动恢复。后续根据实际被限流的情况再深入。

### 有意不做

- **WebGL 指纹欺骗**：site-use 使用用户本地真实 Chrome，WebGL 返回的是用户真实 GPU 信息，与正常浏览一致，无需伪造
- **Client Hints 一致性**：同理，真实 Chrome 的 User-Agent 和 `Sec-CH-UA` 系列 HTTP 头天然一致，不存在不匹配问题
- **Patchright / TLS 指纹模拟**：真实 Chrome 的 TLS 指纹就是真的，不需要 Playwright 的 stealth fork
- **browserforge Header 生成**：不直接发 HTTP 请求，浏览器自带真实 Headers

以上是 Scrapling / xiaohongshu-skills 等项目用于"伪造浏览器环境自圆其说"的技术。site-use 的设计思路是"用真实环境"，因此不需要伪造层。

### 待深入研究

- Twitter 的具体反爬检测维度（行为模式、请求频率、指纹检查）
- 更精细的行为模拟（鼠标轨迹、滚动速度曲线、打字节奏）
- CDP 端口暴露的缓解方案
- Puppeteer stealth 插件评估

---

## 新站点接入决策流程

site-use 以 Twitter 切入，但未来会扩展到更多站点。每接入一个新站点，核心问题是：**用什么提取策略？** 这是一个事前的 research 流程，产出是确定的策略选择，之后固化为 workflow 代码，运行时不再决策。（来源：[Firecrawl 对比分析 §7](comparisons/site-use-vs-firecrawl-comparison.md#七新站点接入决策流程)、[ScrapeGraphAI 对比分析 §5.3 新站点冷启动流程](comparisons/site-use-vs-scrapegraph-ai-comparison.md#53-具体建议)）

### 决策树

```
新站点接入
  │
  ▼
┌────────────────────────────────────────┐
│ Step 1：打开 DevTools Network 面板      │
│ 操作目标页面（滚动、点击、搜索）         │
│ 观察网络请求                            │
└──────────────┬─────────────────────────┘
               │
               ▼
        有结构化 API 请求？
      （GraphQL / REST JSON）
        ┌──── 是 ────┐
        │            │
        ▼            ▼ 否
  ┌──────────┐  ┌────────────────────────┐
  │ 最优路径  │  │ Step 2：Console 面板    │
  │ 拦截 API │  │ 检查 JS 全局状态对象     │
  │ 响应     │  │ __INITIAL_STATE__       │
  └──────────┘  │ __NEXT_DATA__          │
                │ React fiber / store     │
                └──────────┬─────────────┘
                           │
                           ▼
                   有可用状态对象？
                 ┌──── 是 ────┐
                 │            │
                 ▼            ▼ 否
           ┌──────────┐  ┌──────────────────┐
           │ 次优路径  │  │ Step 3：DOM 结构  │
           │ evaluate  │  │ 检查语义化标签     │
           │ 读状态    │  │ + ARIA 属性       │
           └──────────┘  └────────┬─────────┘
                                  │
                                  ▼
                          DOM 结构清晰？
                        ┌──── 是 ────┐
                        │            │
                        ▼            ▼ 否
                  ┌──────────┐  ┌──────────────┐
                  │ 可用路径  │  │ 兜底路径      │
                  │ DOM 解析  │  │ 清洗 HTML     │
                  │ + 选择器  │  │ + LLM 提取    │
                  └──────────┘  └──────────────┘
```

### 站点分类矩阵

不是所有站点都值得投入人力写确定性规则（来源：[ScrapeGraphAI 对比分析 §3.4](comparisons/site-use-vs-scrapegraph-ai-comparison.md#34-关键判断考虑多站点扩展)）。按"调用频率 × ARIA 支持"四象限决定提取策略：

| 站点特征 | 推荐提取策略 | 理由 |
|----------|------------|------|
| 高频 + ARIA 好（如 Twitter） | 确定性（ARIA + fingerprint） | 成本低、延迟低、准确率高 |
| 高频 + ARIA 差 | 确定性（CSS/XPath + fingerprint） | LLM 成本随频率线性增长，不划算 |
| 低频 + ARIA 好 | 确定性（ARIA） | 实现简单，维护少 |
| 低频 + ARIA 差 | **LLM 提取作为长期方案** | 手写规则 ROI 低，LLM 零维护 |
| 新站点冷启动 | **LLM 提取 → 逐步迁移到确定性** | 先跑通再优化 |
| 所有确定性策略失效 | **LLM 终极 fallback** | 比返回空结果好 |

### Research Spike 检查清单

每个新站点接入前，按此清单逐项检查，产出一份简短的策略决策记录：

**网络层检查**：
- [ ] 目标操作（浏览列表、搜索、查看详情）触发了哪些 API 请求？
- [ ] API 返回 JSON 还是其他格式？
- [ ] API 是否需要认证 token？token 从哪来？（通常 cookies 里有）
- [ ] API endpoint 是否带版本号或 hash？（有 hash 的 GraphQL 可能频繁变化）

**JS 状态检查**：
- [ ] `window.__INITIAL_STATE__` 或 `window.__NEXT_DATA__` 是否存在？
- [ ] React DevTools 能否看到组件树和 state？
- [ ] 数据是否在首屏渲染时就存在（SSR），还是动态加载？

**DOM 结构检查**：
- [ ] 目标内容有没有语义化容器？（`<article>`、`role="listitem"` 等）
- [ ] 关键字段（标题、作者、时间、正文）能否用稳定选择器定位？
- [ ] 时间戳是真实值还是"3 小时前"这种相对格式？

**操作层检查**（与提取策略无关，但接入时一并完成）：
- [ ] 关键交互元素的 ARIA 属性是否完善？（role + name）
- [ ] 站点是否有反爬保护？什么级别？（Cloudflare / 自研 / 无）
- [ ] 是否需要代理？

**产出**：一份策略决策记录，格式如：
```
站点：reddit.com
提取策略：API 拦截（Reddit JSON API，无需 GraphQL）
操作策略：ARIA 匹配（Reddit 无障碍支持良好）
反爬等级：低（Reddit 对浏览器访问宽松）
特殊注意：无限滚动需要停滞检测
```

### 策略固化

决策完成后，策略固化为 workflow 代码：

```
sites/
  └─ reddit/
      ├─ matchers.ts      ← 操作定位规则（来自 ARIA 检查结果）
      ├─ workflows.ts     ← 操作流程
      └─ extractors.ts    ← 提取实现（来自策略决策）
                              内部用 API 拦截 / JS 状态 / DOM / LLM
                              对 workflow 暴露统一接口
```

workflow 层只调 `extractors.getItems(page): Promise<T[]>`，不关心内部用了哪种策略。运行时不再做策略选择。

### 架构预留 R4：Research Spike 自动化

当前 research spike 是纯人工流程（在 DevTools 中手动执行探测脚本、查看结果、做决策）。但 Twitter spike（2026-03-19）验证了一个关键事实：**spike 的每一步都可以映射到 Primitives 原语**：

| 人工步骤 | 对应 Primitives 原语 |
|----------|---------------------|
| Network 面板观察 API 请求 | `interceptRequest(pattern)` |
| Console 检查全局状态对象 | `evaluate('window.__NEXT_DATA__')` |
| Console 执行 DOM 选择器 | `evaluate('document.querySelector(...)')` |
| Accessibility 面板检查 ARIA 树 | `takeSnapshot()` |

决策逻辑也是确定性的（决策树已在上文定义）。这意味着未来扩展新站点时，可以实现一个 `autoSpike(url)` 工具：

1. 自动导航到目标 URL
2. 依次执行四条路径的探测脚本
3. 输出字段覆盖率矩阵
4. 按决策树给出推荐策略
5. 人 review 结论，确认后自动生成策略决策记录

**当前不实现**——只有一个站点时手动 spike 的成本可忽略。触发条件：第二个站点接入时评估 ROI。

---

## 错误处理

### 职责边界

```
站点适配层        Fingerprint 层        Primitives 层     MCP Server       MCP Client (Caller)
  │                │                     │                │                │
  │ 领域错误       │ 降级匹配             │ 操作错误        │ 包装为 MCP     │ 恢复决策
  │ SessionExpired │ ElementFoundBy       │ ElementNotFound │ tool error     │ 重试/问用户
  │ RateLimited    │   Fallback           │ NavigationFailed│ (isError:true) │ /放弃
  │                │ (候选+置信度)         │ Timeout         │                │
```

### 错误分类

| 错误类型 | 产生位置 | 含义 | 重试策略 | caller 应该怎么做 |
|----------|----------|------|----------|------------------|
| `SessionExpired` | 站点适配层（auth-guard） | 需要用户重新登录 | 不可重试（跟策略无关） | 提示用户登录 |
| `ElementNotFound` | Sites 层（workflows.ts） | ARIA 语义匹配 + 指纹 fallback 均未找到目标（可能页面改版） | 不可重试（跟策略无关） | 报告错误，人工介入 |
| `ElementFoundByFallback` | Fingerprint 层 | ARIA 匹配失败，但指纹 fallback 找到候选元素 | 不可重试（候选需人工确认） | 评估候选置信度，决定是否采用 |
| `NavigationFailed` | Primitives 层 | 页面加载超时/意外重定向 | Primitives 层内部重试 2-3 次；仍失败则抛给 caller | 可重试 |
| `RateLimited` | 站点适配层 | 被限流（429 或验证码页面） | 不自动重试（跟策略无关，需要等待） | 等待后重试或放弃 |
| `BrowserDisconnected` | MCP Server | Chrome 被关闭或崩溃 | Server 自动重连；仍失败则抛给 caller | 重新发起 tool call |

区分原则（参考 [Firecrawl §6.3 引擎瀑布中的错误处理](comparisons/site-use-vs-firecrawl-comparison.md#63-引擎瀑布中的错误处理)）：**换策略/重试可能解决的错误 → Primitives 层内部重试**；**跟策略无关的错误 → 立即传播给 caller**。

### 设计原则

1. **site-use 不做恢复决策** — 只检测、分类、抛出。恢复逻辑属于 caller（Skill 有 AI 能力和用户上下文）
2. **Primitives 层内部重试临时失败** — 网络抖动、DOM 短暂不稳定等，内部重试 2-3 次，不暴露给上层
3. **错误带上下文** — 不只是类型和消息，还附带当前 URL、操作步骤、最后看到的页面状态，方便 caller 判断
4. **错误时自动截图** — `ElementNotFound` 等关键错误发生时，自动调用 `screenshot()` 并将截图（base64 PNG）附在错误上下文中返回，帮助 caller/agent 判断页面实际状态

---

## MCP 工具接口

### 工具命名规范

`<site>_<action>`，与 devtools-mcp 的扁平命名风格一致。

### 输出协议

所有工具返回 MCP 标准的 `TextContent`，内容为 JSON：

**成功**：
```json
{
  "content": [{
    "type": "text",
    "text": "{\"data\":[...],\"meta\":{\"tweetCount\":50,\"coveredUserCount\":23}}"
  }]
}
```

**失败**（`isError: true`）：
```json
{
  "content": [{
    "type": "text",
    "text": "{\"type\":\"SessionExpired\",\"message\":\"...\",\"context\":{\"url\":\"...\"}}"
  }],
  "isError": true
}
```

**进度**：通过 MCP 协议的 progress notification 上报（如果 client 支持）。

### Agent 友好性设计原则

site-use 的 MCP 工具会被 OpenClaw 等 AI Agent 调用。Agent 不能 Google、不能问同事——工具返回值是它唯一的信息来源。以下原则确保 Agent 高效使用 site-use（来源：Manus 后端负责人的 CLI Agent 实践总结，2026-03-19）。

#### 原则 1：错误消息即导航

每个错误不仅说明"出了什么问题"，还要指向"应该怎么做"。Agent 看到错误后应能一步自纠正，而不是盲目重试。

```
差：
  { "type": "ElementNotFound", "message": "Follow button not found" }
  → Agent 不知道下一步，可能盲目重试同一操作

好：
  {
    "type": "ElementNotFound",
    "message": "Follow button not found",
    "context": {
      "url": "https://x.com/someuser",
      "hint": "Page may have changed. Try twitter_check_login first to verify session, or twitter_search_user to confirm user exists.",
      "lastSnapshot": "... (truncated accessibility tree summary) ..."
    }
  }
  → Agent 知道接下来可以尝试什么
```

`ElementFoundByFallback` 同理——返回候选时附带可操作建议：
```
{
  "type": "ElementFoundByFallback",
  "candidates": [{ "uid": "42", "score": 0.82, "description": "button 'Following'" }],
  "hint": "Top candidate (score 0.82) appears to be the 'Following' (unfollow) button, not 'Follow'. Verify user is not already followed."
}
```

#### 原则 2：输出截断 + 溢出引导

大数据结果（如 `twitter_timeline` 返回 200+ 推文）不应一次性塞满 Agent 上下文。截断 + 告知总量 + 给出获取更多数据的方法：

```json
{
  "data": [ "... first 50 tweets ..." ],
  "meta": {
    "returned": 50,
    "total": 237,
    "hint": "Call twitter_timeline with offset=50 to get more."
  }
}
```

Agent 已知如何分页——关键是告诉它总量和如何继续。

#### 原则 3：一致的结果元数据

每次工具调用的返回值附带一致的元数据，让 Agent 随时间内化操作成本：

```json
{
  "data": { ... },
  "meta": {
    "durationMs": 3200,
    "pageUrl": "https://x.com/home"
  }
}
```

- **耗时**：Agent 看到 `twitter_timeline` 耗时 3200ms 而 `twitter_check_login` 耗时 120ms，会自然学会避免不必要的重操作
- **当前 URL**：帮助 Agent 理解浏览器状态，无需额外调用

#### 原则 4：stderr 不可丢弃

Primitives 层执行浏览器操作时产生的警告、错误信息（如 CDP 错误、页面 JS 异常）必须在工具返回值中透传。静默丢弃错误细节会导致 Agent 盲目猜测，浪费大量调用轮次（经验教训：丢弃 stderr 导致 10 次盲目重试 vs 保留 stderr 时 1 次即可纠正）。

### 调试用 CLI

开发和调试时可以用通用 MCP CLI 工具调用 site-use：

```bash
# 使用 MCP Inspector（官方调试工具）
npx @anthropic-ai/mcp-inspector site-use

# 或直接用 mcp-cli
npx @anthropic-ai/mcp-cli --server "npx site-use" --tool twitter_timeline --params '{"count":50}'
```

不再需要自己维护 CLI 解析层。

---

## 技术栈

- **语言**：TypeScript
- **运行时**：Node.js
- **MCP SDK**：@modelcontextprotocol/sdk（MCP server + stdio transport）
- **浏览器控制**：Puppeteer（通过 CDP 连接用户的 Chrome）
- **Schema 验证**：Zod（MCP 工具参数定义）
- **元素指纹存储**：better-sqlite3（元素指纹持久化，支持指纹 fallback 机制）
- **包形态**：npm 包 + bin 入口（MCP server 启动）
- **测试**：Vitest（待定）

---

## 待解决问题（实现时决定）

1. **内容提取策略**：5 层策略栈（① GraphQL/API 拦截 → ② JS 状态对象 → ③ ARIA+DOM 解析 → ④ Fingerprint 重定位 → ⑤ LLM 兜底提取）— 每个站点通过 research spike 确定使用哪几层。详见 extractors.ts 章节和新站点接入决策流程章节
2. **数据目录布局**：Chrome profile、日志的存放位置 — 定一个约定（如 `~/.site-use/`）
4. ~~**自愈匹配引擎**~~：**已确认方案** — 双层匹配策略：ARIA 语义匹配为主，元素指纹相似度 fallback 为辅。每次 ARIA 匹配成功时 auto_save 元素指纹到 SQLite，匹配失败时用指纹相似度重定位，返回候选列表 + 置信度由 caller 决定。详见 matchers.ts 章节的"双层匹配策略"。参考：Scrapling 的 `relocate` + `auto_save` 机制
5. **反爬深度**：基础节奏控制 + 指纹配置 + WebRTC 泄露防护 + Canvas 噪声 + Cloudflare 挑战处理（可选中间件）。详见反爬策略章节
6. **Puppeteer 辅助功能树实现**：需要验证 Puppeteer 通过 CDP `Accessibility.getFullAXTree` 获取的辅助功能树结构是否与 devtools-mcp 的 `take_snapshot` 返回格式一致，确保 matchers 规则可以无缝迁移
7. **扩展同步**：MVP 使用专用 Chrome profile，用户需手动安装必要扩展（如代理插件）。未来可支持从用户主 profile 自动同步扩展到专用 profile（复制 `Extensions/` 目录或 `--load-extension`），避免重复配置
8. **无限滚动加载模式**：扩展站点时（Twitter 回复串、Reddit 评论区等）需要通用的滚动加载 workflow 模式——`scroll` + `evaluate`（或 `interceptRequest`）循环采集，配合停滞检测（连续 N 次滚动无新内容则停止）和数量阈值跳过（如跳过超长回复串）。参考 [xiaohongshu-mcp 的评论滚动加载实现](comparisons/site-use-vs-xiaohongshu-mcp-comparison.md#内容获取)（停滞检测 + 回复数量阈值）。现有 Primitives 原语已足够支撑，这是 workflow 层的编排模式，不需要新原语

---

## 修订记录

- 2026-03-17：通过 brainstorming 创建初始设计文档
- 2026-03-17：补充 MCP 连接模型、错误处理、API 一致性修复
- 2026-03-18：**完全重写** — 基于 PRD 对齐的新架构：
  - 去掉 Chrome DevTools MCP 中间层，改为 Puppeteer + CDP 直连
  - 新增 daemon 进程设计（lazy 启动、状态机、空闲超时）
  - 新增两层架构（core + sites），预留向声明式引擎演进的路径
  - 新增反爬策略框架（三层体系）
  - 新增 CLI 接口设计（agent 友好的输出协议）
  - 引入小红书适配层模式（选择器集中管理、JS 状态对象提取）
  - 解决 PRD 待明确问题（KOL 列表：按需获取；选择器：MVP 硬编码）
  - Spec review 修复：新增 TimelineMeta 结构、深挖策略、选择器维护方案、Chrome 路径发现、首次使用编排职责边界、npm API 推迟说明
- 2026-03-18：**引入 Primitives 层**，与 chrome-devtools-mcp 工具接口同构：
  - 原 Core 层拆分为 Primitives 层（原语接口 + 后端实现）和 Browser 层（浏览器生命周期）
  - 元素定位从 CSS 选择器改为辅助功能树 snapshot uid（对齐 devtools-mcp 的 take_snapshot 机制）
  - selectors.ts → matchers.ts：从 CSS 选择器改为语义匹配规则（role + name）
  - 新增 puppeteer-backend.ts / 未来 devtools-mcp-backend.ts 可切换设计
  - throttle.ts 移入 Primitives 层，确保任何后端都有节奏保护
- 2026-03-18：**CLI + IPC → MCP Server**：
  - 去掉 CLI 层和自定义 IPC 协议，改为标准 MCP server（@modelcontextprotocol/sdk + stdio transport）
  - 去掉 daemon 进程设计（MCP server 本身就是常驻进程，由 MCP client 管理生命周期）
  - 每个 workflow 注册为 MCP tool（twitter_timeline、twitter_follow 等）
  - 与 devtools-mcp 成为同类架构，差异仅在暴露的工具粒度（高层业务工具 vs 低层浏览器原语）
- 2026-03-18：**新增多页面管理**：
  - puppeteer-backend.ts 持有 `Map<site, Page>`，每个站点一个 tab，lazy 创建
  - Workflow 调用自动路由到对应站点的 page，对 MCP client 透明
  - 不需要 devtools-mcp 的 Context Layer，只是简单的 site → page 映射
- 2026-03-18：**反爬增强**（参考 xiaohongshu-mcp 对比分析）：
  - throttle.ts 新增点击坐标抖动（±3px 随机偏移）
  - browser.ts 新增代理支持（`SITE_USE_PROXY` 环境变量 → Chrome `--proxy-server` 参数）
- 2026-03-18：**引入元素指纹 Fallback + 反爬增强**（参考 Scrapling 对比分析）：
  - 新增 Fingerprint 层：元素指纹采集（多维特征）+ 相似度匹配 + SQLite 持久化（better-sqlite3）
  - matchers.ts 双层匹配策略：ARIA 语义匹配为主，指纹相似度 fallback 为辅
  - auto_save 机制：ARIA 匹配成功时自动保存元素指纹，持续积累 fallback 数据
  - 新增 `ElementFoundByFallback` 错误类型（候选列表 + 置信度）
  - 反爬第 1 层新增：WebRTC 泄露防护（代理模式下）、Canvas 指纹噪声
  - 反爬第 3 层新增：Cloudflare 挑战处理（可选中间件，扩展新站点时启用）
  - 待解决问题 #4（自愈匹配引擎）标记为已确认方案
- 2026-03-19：**整合 [Firecrawl](comparisons/site-use-vs-firecrawl-comparison.md) + [ScrapeGraphAI](comparisons/site-use-vs-scrapegraph-ai-comparison.md) 对比分析的借鉴项**：
  - 模块边界原则新增第 4 条：外部页面内容不可信（prompt injection 防御）
  - extractors.ts 从平铺 4 策略升级为 5 层优先级策略栈（新增 LLM 兜底作为第 5 层）
  - extractors.ts 新增 LLM 兜底路径架构预留（R1 接口不暴露策略、R2 清洗层独立、R3 Zod 单一 schema 来源）
  - 新增「新站点接入决策流程」章节：决策树、站点分类矩阵（调用频率 × ARIA 支持四象限）、research spike 检查清单、策略固化
  - 错误分类表新增「重试策略」列：区分可重试 vs 不可重试，明确 Primitives 层内部重试 vs 立即传播的边界
  - 反爬第 3 层新增广告/追踪域名屏蔽（站点级可选配置）
  - 待解决问题 #1 从「4 策略待研究」更新为「5 层策略栈」
- 2026-03-19：**新增 Agent 友好性设计原则**（来源：Manus 后端负责人的 CLI Agent 实践总结）：
  - MCP 工具接口章节新增 4 条原则：错误消息即导航、输出截断+溢出引导、一致的结果元数据、stderr 不可丢弃
  - 指导 site-use 作为被 OpenClaw 等 Agent 调用的工具时，返回值如何设计以提升 Agent 调用效率
