# 能力 1：Browser 层 — 启动并连接 Chrome

> 上游文档：[技术架构设计](../../site-use-design.md) — Browser 层章节，[M1 里程碑](../overview.md) — 能力 1
> 状态：已完成（2026-03-20）

## 目标

用户执行 `npx site-use`，第一个 tool call 到来时自动弹出一个干净的 Chrome 窗口。用户无需手动配置 Chrome。

---

## 完成后你能感受到什么

1. **Chrome 自动弹出** — 第一个 MCP tool call 到来时，Chrome 窗口自动打开，无需手动启动或配置
2. **登录一次，永久记住** — 在弹出的 Chrome 中登录 Twitter 后，下次启动不需要重新登录（独立 profile 持久保存 cookies）
3. **不影响日常浏览器** — site-use 的 Chrome 是独立实例，不会动你正在用的浏览器的 cookies、历史记录
4. **代理开箱即用** — 已有 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量的直接生效，也可以用 `SITE_USE_PROXY` 单独指定；启动时 log 显示代理来源
5. **关掉 server 不丢浏览器** — MCP server 退出后 Chrome 窗口保留，可以继续手动浏览
6. **Chrome 崩溃自动恢复** — 如果 Chrome 意外关闭，下一个 tool call 会自动重新启动

---

## 文件

- `src/browser/browser.ts` — Chrome 生命周期管理
- `src/browser/welcome.ts` — 首次启动欢迎页
- `src/config.ts` — 配置模块（环境变量、代理、数据目录）
- `src/errors.ts` — 错误类型定义
- `src/index.ts` — CLI 入口和命令路由
- `src/diagnose/` — 反检测诊断系统（runner、registry、22 个检查项）

---

## 设计理由

### 为什么 site-use 自己管理 Chrome，而不是连接用户已有的浏览器

devtools-mcp 的做法是连接用户已打开的 Chrome（通过 `--remote-debugging-port`），但 site-use 选择**启动独立实例**：

1. **沙盒隔离**：site-use 在独立 profile 中操作 Twitter，不影响用户日常浏览器的 cookies、历史记录、已登录的其他服务
2. **用户体验**：用户不需要学习"先用特殊参数启动 Chrome"——MCP client 调一个 tool，Chrome 自动弹出来
3. **登录态持久**：独立 profile 意味着用户只需登录一次 Twitter，后续启动自动复用 cookies（Chrome profile 目录持久保存在 `~/.site-use/chrome-profile/`）

### 为什么用用户本地 Chrome 而不是 Puppeteer 自带的 Chromium

Puppeteer 默认下载自带的 Chromium，但 site-use 用 `channel: 'chrome'` 指向用户本地 Chrome：

1. **反爬**：Chromium 的 User-Agent、TLS 指纹、WebGL 返回值都与 Chrome 有微妙差异，有些反爬系统能区分。用真实 Chrome 从指纹层面就是"正常用户"
2. **体积**：不强制下载 ~170MB 的 Chromium，`npm install` 更快
3. **功能一致**：用户已有的扩展和字体在本地 Chrome 中可用（虽然独立 profile 不共享扩展，但字体和编解码器是系统级的）

### 为什么 server 退出时不关闭 Chrome

Chrome 窗口对用户是可见的——这是 site-use 的**产品特性**，不是技术限制。用户可能想在 MCP server 退出后继续在这个浏览器里手动操作。如果 server 退出就杀 Chrome，用户会丢失正在浏览的页面。

---

## 职责

1. **启动 Chrome**：使用用户本地安装的 Chrome，独立 profile，随机 CDP 端口
2. **单例管理**：模块级 `Browser` 单例，整个进程只有一个浏览器实例
3. **断线检测**：每次使用前检查 `browser.connected`，断开则重新启动
4. **代理注入**：通过 Chrome 启动参数配置代理（国内访问 Twitter 的前提条件）
5. **不关闭 Chrome**：MCP server 退出时不关浏览器，用户自行决定

---

## 导出接口

```typescript
// 确保浏览器可用，断线或首次调用时自动启动
ensureBrowser(): Promise<Browser>

// 清除单例引用（不关闭 Chrome 进程）
closeBrowser(): Promise<void>

// 检查浏览器是否连接中
isBrowserConnected(): boolean
```

---

## Chrome 启动参数

| 参数 | 作用 | 来源 |
|------|------|------|
| `--user-data-dir=<chromeProfileDir>` | 独立 profile，保持登录态 | `config.chromeProfileDir` |
| `--remote-debugging-port=0` | 随机 CDP 端口。用默认 9222 的风险：恶意网页可以通过 `fetch('http://localhost:9222/json')` 探测到 CDP 端口并注入命令。随机端口不能完全消除风险，但大幅提高探测成本 | 固定值 |
| `--no-first-run` | 跳过首次运行向导 | 固定值 |
| `--no-default-browser-check` | 跳过默认浏览器检查 | 固定值 |
| `--hide-crash-restore-bubble` | 抑制 Chrome 崩溃恢复提示栏 | 固定值 |
| `--disable-blink-features=AutomationControlled` | 防止 `navigator.webdriver=true`，比去掉 `--enable-automation` 更彻底 | 固定值 |
| `--window-size=1920,1080` | 标准化窗口尺寸，避免异常分辨率被用作指纹 | 固定值 |
| `--lang=en-US` | 浏览器界面语言（Sites 层 ARIA matchers 依赖英文界面） | 固定值 |
| `--accept-lang=en-US,en` | HTTP Accept-Language 头 | 固定值 |
| `--restore-last-session` | 配合 Preferences 的会话恢复设置 | 固定值 |
| `--no-sandbox` | Linux 专用，无沙盒环境下必需 | 仅 Linux |
| `--proxy-server=<proxy>` | HTTP/SOCKS5 代理 | `config.proxy.server`（仅当配置了代理时） |
| `ignoreDefaultArgs: ['--enable-automation', '--disable-extensions']` | 去掉 automation 标志 + 允许用户扩展正常工作 | Puppeteer 选项 |

### Puppeteer launch 配置

| 选项 | 值 | 说明 |
|------|---|------|
| `channel` | `'chrome'` | Puppeteer 的浏览器品牌选择参数（可选值：`chrome`/`chrome-beta`/`chrome-canary`/`chrome-dev`）。设置后 Puppeteer 按操作系统标准安装路径查找对应浏览器，不使用自带的 Chromium |
| `headless` | `false` | 用户必须看到浏览器——产品特性 |

---

## 代理支持

通过环境变量配置，读取自 `config.ts`：

| 环境变量 | 说明 | 示例 |
|---------|------|------|
| `SITE_USE_PROXY` | HTTP/SOCKS5 代理地址 | `http://127.0.0.1:7890` |
| `SITE_USE_PROXY_USER` | 代理用户名（可选） | `user` |
| `SITE_USE_PROXY_PASS` | 代理密码（可选） | `pass` |

### 代理地址 fallback 链

`SITE_USE_PROXY` → `HTTPS_PROXY` → `HTTP_PROXY`（依次尝试，取第一个有值的）。这样已有系统代理变量的用户无需重复配置。

启动时 log 代理来源，方便排查问题：
- `Proxy: http://127.0.0.1:7890 (from SITE_USE_PROXY)`
- `Proxy: http://127.0.0.1:7890 (from HTTPS_PROXY fallback)`
- `Proxy: none`

### 代理分层处理

- 代理地址 → Chrome `--proxy-server` 启动参数
- 代理认证 → Puppeteer `page.authenticate()`（在 Primitives 层创建 page 时调用）

**对用户无感**——用户只需配置 `SITE_USE_PROXY` / `SITE_USE_PROXY_USER` / `SITE_USE_PROXY_PASS`，代理就能工作。分层处理纯粹是 Chrome/CDP 的技术限制：`--proxy-server` 是 Chrome 的进程级启动参数（必须在 `puppeteer.launch()` 时传入，启动后不可修改），而 `page.authenticate()` 是 CDP 的页面级 API（通过监听 `Fetch.authRequired` 事件响应代理的 407 认证挑战，必须绑定到具体 `Page` 对象）。两个 API 在不同层级生效，所以 browser.ts 处理路由，Primitives 层在创建 `Page` 时处理认证。

---

## 状态与生命周期

```
ensureBrowser() 被调用
    │
    ├─ browserInstance 存在且 connected → 返回现有实例
    │
    └─ browserInstance 为 null 或 disconnected
        │
        └─ puppeteer.launch(...) → 设置 browserInstance
            │
            └─ 监听 'disconnected' 事件 → 将 browserInstance 置 null
```

- **Lazy 启动**：browser.ts 不在 import 时启动 Chrome，只在 `ensureBrowser()` 被调用时启动
- **断线自动重启**：`ensureBrowser()` 发现断线就重新 launch
- **不关闭 Chrome**：`closeBrowser()` 只清引用，不调 `browser.close()`

---

## config.ts — 配置模块

Browser 层依赖的配置模块，单独一个文件 `src/config.ts`：

### 导出接口

```typescript
interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

interface Config {
  dataDir: string;         // 默认 ~/.site-use/
  chromeProfileDir: string; // dataDir/chrome-profile/
  proxy?: ProxyConfig;
}

getConfig(): Config
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SITE_USE_DATA_DIR` | `~/.site-use/` | 数据根目录 |
| `SITE_USE_PROXY` | fallback `HTTPS_PROXY` → `HTTP_PROXY` | 代理地址 |
| `SITE_USE_PROXY_USER` | 无 | 代理用户名 |
| `SITE_USE_PROXY_PASS` | 无 | 代理密码 |

### 目录布局

```
~/.site-use/              # SITE_USE_DATA_DIR
├── chrome-profile/       # Chrome 用户数据
└── data/                 # 预留给 M4 SQLite
```

---

## errors.ts — 错误类型

Browser 层和其他层共用的错误类型，单独一个文件 `src/errors.ts`：

### M1 定义的 3 个错误类型

| 错误 | 产生位置 | 语义 |
|------|---------|------|
| `BrowserDisconnected` | browser.ts | Chrome 被关闭、崩溃或启动失败 |
| `SessionExpired` | Twitter workflows | 用户需要重新登录 |
| `ElementNotFound` | Twitter workflows | ARIA 匹配找不到目标元素 |

### 为什么 errors.ts 和 config.ts 在本文档讲而不是单独成文档

errors.ts 和 config.ts 是被多层共用的基础模块，但它们太小了（各 ~30 行），不值得独立设计文档。它们的主要消费者是 Browser 层和 MCP Server 层，放在 Browser 层文档中讨论是因为 Browser 层最先被实现，最先需要这两个模块。

### 为什么 M1 就定义 3 个错误类型（而不是推迟到 M3）

最初里程碑设计将所有错误处理推迟到 M3。但 spec review 时发现：M1 的 workflow 必须处理"未登录"和"元素找不到"这两种情况，否则 workflow 只能抛通用 Error，MCP client 无法区分"需要用户登录"和"代码 bug"。M1 定义最小错误集让 caller 能做基本决策，M3 扩充更多类型（`RateLimited`、`NavigationFailed`）和增强上下文（自动截图）。

### 错误上下文

每个错误携带结构化 context，方便 MCP client 做决策：

```typescript
interface ErrorContext {
  url?: string;           // 出错时的页面 URL
  step?: string;          // 出错的操作步骤描述
  snapshotSummary?: string; // ARIA 匹配失败时的辅助功能树摘要，帮助诊断页面状态（元素未加载？页面不对？Twitter 改版？）
  screenshotBase64?: string; // 自动截图（M3 增强，M1 预留字段）
}
```

---

## 实现记录（超出原始设计的新增功能）

以下功能是在实现 Browser 层过程中有机长出来的，原始设计文档没有覆盖。

### CLI 命令体系

原始设计只定义了 `ensureBrowser()` 作为程序化接口。实现时增加了完整的 CLI，方便开发调试：

```
site-use serve              # 启动 MCP server（stdio transport）
site-use browser launch     # 启动 Chrome 并保持运行
site-use browser status     # 显示配置信息（profile 路径、代理）
site-use browser close      # 清除单例引用（Chrome 进程保留）
site-use help               # 帮助信息
```

**launch 选项**：
- `--diagnose` — 启动后运行反检测诊断
- `--keep-open` — 诊断后保持浏览器和检测页面打开
- 额外 `--flags` 直接透传给 Chrome（如 `--disable-web-security`）

文件：`src/index.ts`

### 反检测诊断系统

用于验证 Chrome 配置是否能通过反爬检测。通过 `site-use browser launch --diagnose` 触发。

**架构**：
- 本地 HTTP 服务器（127.0.0.1 随机端口），提供检测页面
- 模块化检查注册机制（`src/diagnose/registry.ts`）
- 浏览器端检查编译为 IIFE bundle（`dist/diagnose/checks.js`）
- 构建时自动生成 barrel 文件（`_browser-barrel.ts`）

**22 个检查项**（18 browser + 3 node + 1 deferred input）：

| 类别 | 检查项 | 说明 |
|------|--------|------|
| WebDriver | `navigator.webdriver`、descriptor、`in` operator | 基础自动化检测 |
| Chrome 对象 | `window.chrome`、`chrome.runtime` | 浏览器真实性 |
| 浏览器属性 | plugins、languages、connection.rtt、window size | 环境一致性 |
| 注入检测 | CDC globals、Selenium、Playwright | 自动化框架痕迹 |
| 行为检测 | input trusted、input coords | 事件真实性 |
| 其他 | canvas visualizer、pdf style、popup crash、UA override、UA worker | 各类指纹 |
| Node 端 | browser info、stack signature、launch args | 进程级检测 |

**结果状态**：`PASS` / `FAIL` / `KNOWN`（已知失败）/ `INFO`（仅报告，不判定）

文件：`src/diagnose/`

### Chrome 启动增强

原始设计只列出 6 个启动参数，实现时增加了以下参数：

| 参数 | 作用 |
|------|------|
| `--disable-blink-features=AutomationControlled` | 比去掉 `--enable-automation` 更强的反检测措施 |
| `--window-size=1920,1080` | 标准化窗口尺寸，避免异常分辨率成为指纹 |
| `--lang=en-US` + `--accept-lang=en-US,en` | 语言一致性（配合 Preferences 文件，三层强制） |
| `--hide-crash-restore-bubble` | 抑制崩溃恢复提示 |
| `--restore-last-session` | 配合会话恢复 |
| `ignoreDefaultArgs` 新增 `--disable-extensions` | 允许用户已安装的扩展正常工作 |

### 会话恢复

通过 `fixPreferences()` 在启动前修改 Chrome Preferences 文件：
- `session.restore_on_startup = 1` — 下次启动自动恢复之前的标签页
- `intl.accept_languages = 'en-US,en'` — 语言第三层强制（profile 级别，覆盖 Chrome 内部保存的语言偏好）

### 欢迎页

首次启动时（只有一个 about:blank 标签），展示欢迎页面（`src/browser/welcome.ts`）。会话恢复时（有多个标签），自动关闭多余的 about:blank 标签。

### 进程退出处理

`browser launch` 模式下，SIGINT/SIGTERM 清除单例引用后 `process.exit(0)` 强制退出，避免诊断服务器等 handle 阻止进程结束。

---

## 测试策略

- **config.ts**：纯函数，可单元测试（mock 环境变量）
- **errors.ts**：纯数据类，可单元测试
- **browser.ts**：需要真实 Chrome，不做自动化单元测试。通过集成测试手动验证

---

## 对未来的支持

| 决策 | 为什么不会返工 |
|------|--------------|
| 数据目录结构 `~/.site-use/` | M4 的 SQLite 放在 `data/` 子目录，路径约定不变 |
| Chrome 启动参数增量模式 | M3 添加 Canvas 噪声和 WebRTC 标志，只是在 `args` 数组里加元素 |
| `ensureBrowser()` 接口 | 上层只依赖这个函数，内部实现可随意调整 |
| 代理 M1 就实现 | 没有代理在国内连不上 Twitter |
