# site-use vs xiaohongshu-mcp 对比

> 日期：2026-03-18
> 用途：设计决策参考——记录从 xiaohongshu-mcp 评估了什么、采纳/拒绝了什么及其理由

## 概览

| 维度 | site-use (Twitter) | xiaohongshu-mcp (小红书) |
|------|-------------------|------------------------|
| **语言** | TypeScript / Node.js | Go 1.24 |
| **浏览器框架** | Puppeteer + CDP | Rod + go-rod/stealth |
| **协议** | MCP (stdio) | MCP (HTTP) + REST API |
| **状态** | 架构设计完成，未编码 | 已上线，~5000 行业务代码 |
| **MCP 工具数** | ~8 | 13 |
| **进程模型** | 常驻 MCP Server，持有浏览器连接 | 每次操作启动新 Chrome 进程，完成后杀掉 |

---

## 内容获取

| 维度 | site-use | xiaohongshu-mcp |
|------|----------|-----------------|
| **元素定位** | 辅助功能树语义匹配（role + name） | CSS 选择器 |
| **数据提取** | 待定（4 种候选策略） | `window.__INITIAL_STATE__` JS 全局状态 |
| **抗改版能力** | 高——ARIA 属性改动会破坏无障碍合规，网站不会轻易改 | 低——CSS 类名、DOM 结构、JS 全局变量名改版即失效 |
| **评论加载** | 未实现（不在 MVP 范围） | 完整——滚动加载、二级回复展开、停滞检测 |
| **多页面管理** | 按站点 Lazy 创建 tab，自动路由 | 每次操作启动新浏览器进程 |

### 关键分析

1. **site-use 的辅助功能树方案更稳定**。`{ role: 'button', name: /^Follow$/i }` 这样的语义规则在 CSS 类名改版时不受影响。Twitter 频繁改 CSS 类名，但几乎不改 ARIA 语义。

2. **xiaohongshu-mcp 的 `__INITIAL_STATE__` 提取效率高**——直接拿到结构化 JSON，无需解析 DOM。但这是对小红书 Vue/Nuxt SSR 内部实现的脆弱绑定。site-use 也在考虑类似策略（GraphQL 拦截或 JS 状态对象），已为此设计了 `interceptRequest` 原语。

3. **xiaohongshu-mcp 写操作更丰富**——发布图文/视频、评论、点赞、收藏。site-use MVP 只聚焦读取 + follow。

---

## 反检测

| 层级 | site-use | xiaohongshu-mcp |
|------|----------|-----------------|
| **浏览器指纹** | 用户本地真实 Chrome + 独立 Profile + 随机 CDP 端口 + 去掉 `--enable-automation` | go-rod/stealth 清除自动化标记，但**每次启动全新空白浏览器**（无历史、无扩展） |
| **User-Agent** | 真实（用户 Chrome） | 仅图片下载时伪装 |
| **操作节奏** | 1-3s 随机延迟 + 渐进滚动 + 逐字输入 + ±3px 点击抖动 | 300-1200ms 随机延迟 + 点击抖动 |
| **会话管理** | 持久化——独立 Profile 保持登录态，Chrome 不随 server 退出 | 有 Cookie 持久化，但进程模型是一次性的 |
| **限流检测** | 检测 429/验证码（MVP 仅检测不恢复） | 无内置速率限制或限流检测 |
| **代理支持** | `SITE_USE_PROXY` 环境变量 → Chrome `--proxy-server` | `XHS_PROXY` 环境变量 |
| **WebGL/Canvas 指纹** | 不需要（真实浏览器） | 未实现 |
| **Client Hints** | 不需要（真实浏览器，天然一致） | 未实现 |

### 关键分析

1. **site-use 的浏览器复用模型在反检测上远优于 xiaohongshu-mcp**。持久化的 Chrome + 独立 Profile（有浏览历史、扩展、登录态）对风控来说是"老用户"。xiaohongshu-mcp 每次启动全新无头 Chrome——对风控来说是"陌生人"。

2. **xiaohongshu-mcp 缺乏限流防护**。没有检测 429、验证码等信号的机制，高频调用容易触发风控。site-use 在 MVP 至少有检测能力。

3. **操作节奏两者接近**，但 site-use 的设计更系统化（明确的三层防御框架）。

4. **参考**：Python 版 xiaohongshu-skills 有更深的五层反检测体系（含 WebGL 指纹欺骗、Client Hints 一致性、键盘延迟模拟）。site-use 不需要这些，因为用的是真实浏览器环境而非伪造环境。

---

## 架构

| 维度 | site-use | xiaohongshu-mcp |
|------|----------|-----------------|
| **分层** | 4 层（MCP Server → Sites → Primitives → Browser） | 3 层（API → Service → Action → Browser） |
| **可扩展性** | 高——Primitives 层与 devtools-mcp 同构，后端可切换 | 中——业务逻辑与 Rod 强耦合 |
| **并发控制** | Mutex 串行化 | 无显式并发控制 |
| **错误分类** | 5 类错误明确分类（SessionExpired/ElementNotFound/RateLimited 等） | 基础 retry-go 重试 |
| **职责边界** | 明确——site-use 提供原子能力，编排属于 caller（Skill） | 混合——service 层包含部分编排逻辑 |
| **语言选型** | TypeScript——Puppeteer 原生、与 devtools-mcp 同语言便于复用 | Go——Rod 够用于一次性进程模型，单二进制部署 |

---

## site-use 从 xiaohongshu-mcp 采纳的

| 特性 | 来源 | 在 site-use 中的位置 |
|------|------|---------------------|
| 点击坐标抖动（±3px） | xiaohongshu-mcp + xiaohongshu-skills（Python） | throttle.ts |
| 环境变量配置代理 | `XHS_PROXY` 模式 | `SITE_USE_PROXY`，browser.ts |
| `interceptRequest` 原语 | 受 `__INITIAL_STATE__` 提取模式启发 | Primitives 层（用于 GraphQL/API 拦截） |
| 无限滚动加载模式 | 评论滚动加载 + 停滞检测 | 记录在待解决问题 #8，未来实现 |

## site-use 有意不采纳的

| 特性 | 理由 |
|------|------|
| WebGL 指纹欺骗 | site-use 使用用户本地真实 Chrome——GPU 信息真实，与正常浏览一致，无需伪造 |
| Client Hints 一致性 | 真实 Chrome 的 User-Agent 和 `Sec-CH-UA` 头天然一致，不存在不匹配问题 |
| CSS 选择器元素定位 | 辅助功能树语义匹配更抗改版 |
| 一次性浏览器进程模型 | 持久连接在反检测和性能上都更优 |
| Go + Rod | TypeScript + Puppeteer 是与 devtools-mcp 同构设计和 Primitives 层的必要选择 |
| Headless 模式 | 用户需要看到操作过程（产品特性）；同时对反检测也更好 |

---

## 参考：xiaohongshu-skills（Python 版）

Python 版小红书自动化比 Go 版有更深的反检测体系：

| 层级 | 技术手段 |
|------|---------|
| 1. Chrome 启动参数 | `--disable-blink-features=AutomationControlled` |
| 2. User-Agent 伪装 | 平台感知 + 版本号匹配（Chrome 136） |
| 3. JS 注入 | `navigator.webdriver=false`、`navigator.plugins`、Client Hints 一致性（通过 `Page.addScriptToEvaluateOnNewDocument`） |
| 4. WebGL 指纹 | VENDOR/RENDERER 伪装 |
| 5. 行为模拟 | 击键延迟 30-80ms、点击 ±3px 抖动、滚动随机化 |

site-use 通过一个根本不同的策略达到同等或更好的反检测效果：**使用真实浏览器环境**而非伪造环境。上述第 1-4 层在浏览器真实的情况下都不需要。第 5 层（行为模拟）已采纳到 throttle.ts。
