# M7：Chrome 常驻 + CLI Workflow

> 状态：设计完成
> 日期：2026-03-23

## 解决的问题

CLI 目前只能执行直接访问 SQLite 的只读操作（`search`、`stats`）。
需要浏览器的 workflow（如 `twitter_timeline`）被锁在 MCP server 内部，因为只有 MCP server 是长驻进程、持有 Puppeteer 连接。

从 CLI 运行 workflow 意味着每次冷启动 Chrome（~5-10 秒），实际不可用。

## 目标

- CLI 直接执行浏览器 workflow（`twitter feed`），参数与 MCP tool 一致，无需每次冷启动 Chrome
- Chrome 只启动一次，常驻运行，CLI 和 MCP server 共享同一个 Chrome 实例
- 多客户端（CLI、MCP server）不会同时操作浏览器 —— 跨进程文件锁防止冲突
- 通过 `<site> <action>` 二级路由，为未来新站点（Reddit、Instagram）预留扩展点

## 不做的

- 不引入 daemon 进程、IPC 协议
- 不做后台定时抓取
- 不做多站点并发（保持全局串行）

---

## 核心接口

```ts
// src/browser/browser.ts

interface ChromeInfo {
  pid: number;
  wsEndpoint: string;       // e.g. "ws://127.0.0.1:9222/devtools/browser/xxx"
}

/**
 * 以 detach 模式启动 Chrome：启动浏览器、写 chrome.json、
 * 断开 Puppeteer 控制（Chrome 保持运行）、返回连接信息。
 */
function launchAndDetach(extraArgs?: string[]): Promise<ChromeInfo>;

/**
 * 连接已有 Chrome，或在 autoLaunch=true 时自动启动。
 * - autoLaunch: false (CLI) → chrome.json 不存在时抛 BrowserNotRunning
 * - autoLaunch: true  (MCP server) → 调用 launchAndDetach() 后连接
 */
function ensureBrowser(opts?: {
  autoLaunch?: boolean;       // 默认 false
  extraArgs?: string[];
}): Promise<Browser>;

// src/lock.ts

/**
 * 获取跨进程文件锁。
 * - 不传 site → 全局锁 (op.lock)
 * - 传 site → 按站点锁 (op.{site}.lock)
 * 竞争时轮询等待（500ms 间隔，30s 超时）。
 * 自动清理死进程遗留的过期锁。
 */
function acquireLock(site?: string): Promise<void>;

/**
 * 释放当前持有的锁。同时注册在 process 'exit' 和 'SIGINT' 上自动清理。
 */
function releaseLock(): void;

/**
 * 在文件锁保护下执行异步操作，自动获取和释放锁。
 * 所有需要浏览器操作的代码都应通过此函数包裹。
 */
function withLock<T>(fn: () => Promise<T>, site?: string): Promise<T>;
```

---

## 架构

Chrome 本身就是"daemon"，不需要额外的后台进程。

```
npx site-use browser launch
  └─ puppeteer.launch() → disconnect() → Node 退出，Chrome 保持运行
  └─ 写入 ~/.site-use/chrome.json { pid, wsEndpoint }

MCP Client ← stdio → MCP Server（长驻）
                        ├─ puppeteer.connect(wsEndpoint)
                        ├─ Primitives 装饰器栈
                        ├─ Store 单例
                        └─ 文件锁 (~/.site-use/op.lock)

CLI（短命进程）
  ├─ puppeteer.connect(wsEndpoint)  ← 同一个 Chrome
  ├─ Primitives 装饰器栈（每次重建，轻量）
  ├─ Store（每次打开/关闭）
  ├─ 文件锁（同一个 op.lock）
  └─ 执行 workflow → disconnect() → 退出
```

### 变化的部分

| 组件 | 之前 | 之后 |
|------|------|------|
| `browser.ts` | 只有 `launch` 模式 | 新增 `connect` 模式，由 `chrome.json` 驱动 |
| `server.ts` | 调用 `ensureBrowser()` 直接 launch | 连接已有 Chrome；未运行时自动 detach 启动 |
| `src/cli/` | 只有 `knowledge.ts`（search/stats） | 新增 `workflow.ts`（浏览器 workflow 命令） |
| `src/index.ts` | 无 workflow CLI 路由 | `twitter feed` 二级路由 |
| 互斥机制 | 进程内 Mutex（`mutex.ts`） | 文件锁（跨进程）+ 进程内 Mutex 保留 |

### 不变的部分

- Primitives 接口及装饰器栈（throttle / auth-guard / rate-limit）
- 存储层（`src/storage/`）
- 站点 workflow 逻辑（`getFeed`、extractors、matchers）
- MCP 协议层（tool 定义、error formatting）

---

## Chrome 生命周期

### 从现有 `browser launch` 迁移

当前 `browser launch`（M1）是**阻塞式**命令：启动 Chrome，可选运行 `--diagnose`，
然后等待 Ctrl+C 再断开。Node 进程一直存活。

M7 改为**即发即走**模式：启动 Chrome、写 `chrome.json`、disconnect、立即退出。
这是 CLI 行为的 breaking change。

- `--diagnose` 移到独立命令：`npx site-use browser diagnose`
  （通过 connect 模式对已运行的 Chrome 执行诊断）
- `--keep-open` 移除 —— Chrome 启动后始终保持运行

### 启动（`browser launch`）

```
npx site-use browser launch
  1. 读取 chrome.json（位于 config.dataDir/chrome.json）
     ├─ 存在 → 检查 pid 是否存活（见下方"PID 存活检查"）
     │   ├─ 存活 → 输出 "Chrome already running (pid NNN)"，退出
     │   └─ 已死 → 删除 chrome.json，继续启动
     └─ 不存在 → 继续启动
  2. puppeteer.launch({
       handleSIGINT: false,
       handleSIGTERM: false,
       handleSIGHUP: false,
       // 其余参数不变（channel, headless, defaultViewport 等）
     })
  3. 获取 browser.wsEndpoint()
     端口 0 让 Chrome 自动选择空闲端口。实际分配的端口通过
     wsEndpoint() 获取并持久化，在 Chrome 进程生命周期内一直有效。
  4. 获取 browser.process().pid
     （browser.process() 仅在 launch() 后可用，connect() 后返回 null）
  5. 写入 chrome.json：
     { "pid": <number>, "wsEndpoint": "ws://127.0.0.1:…" }
  6. 应用启动后 hook：emulateFocus、applyCoordFix、targetcreated 监听器
  7. browser.disconnect()   // 断开控制，Chrome 保持运行
  8. Node 进程退出
```

### 连接（CLI 和 MCP server 共用逻辑）

```
ensureBrowser(opts?: { autoLaunch?: boolean }):
  1. 如果进程内 browserInstance 存在且已连接 → 直接返回
  2. 读取 chrome.json（位于 config.dataDir/chrome.json）
     ├─ 不存在 + autoLaunch=false（CLI 默认）
     │   → 抛出 BrowserNotRunning: "Chrome not running. Run: npx site-use browser launch"
     ├─ 不存在 + autoLaunch=true（MCP server）
     │   → 调用 launchAndDetach()，写 chrome.json，然后连接
     └─ 存在 → 先检查 pid 存活
         ├─ 已死 → 删除 chrome.json，按"不存在"处理
         └─ 存活 → puppeteer.connect({ browserWSEndpoint })
  3. 应用启动后 hook：emulateFocus、applyCoordFix、targetcreated 监听器
     （每次 connect 都必须执行 —— 新的 Puppeteer 连接不会继承之前连接的监听器）
  4. 缓存为 browserInstance
  5. 注册 'disconnected' 事件 → browserInstance = null
```

MCP server 调用 `ensureBrowser({ autoLaunch: true })` 以保持向后兼容 —— 现有 MCP
用户不需要手动 `browser launch`。Chrome 启动后（无论由 MCP server 还是 `browser launch`），
CLI 即可连接使用。

**重要：** `browser.process()` 在 `puppeteer.connect()` 后返回 `null`。
所有 PID 操作必须从 `chrome.json` 读取，不能从 browser 实例获取。

### 关闭（`browser close`）

```
npx site-use browser close
  1. 读取 chrome.json
     ├─ 不存在 → 输出 "Chrome not running"，退出
     └─ 存在 → puppeteer.connect({ browserWSEndpoint })
  2. browser.close()   // 杀死 Chrome 进程
  3. 删除 chrome.json
```

**与 M1 的语义变化：** 当前 `browser close` / `closeBrowser()` 只是清空进程内引用，
不会杀死 Chrome。M7 改为通过 `browser.close()` 真正终止 Chrome 进程。

**MCP server 正连着时 CLI 执行 `browser close` 的情况：** MCP server 的连接被切断，
`disconnected` 事件触发，`browserInstance` 置 null。下次 tool call 时，
`ensureBrowser({ autoLaunch: true })` 发现 `chrome.json` 不存在，自动启动新 Chrome。
无需人工干预。正在执行的 tool call（如果有）会失败并抛出 `BrowserDisconnected`，
MCP client 可以重试。

### 状态（`browser status`）

```
npx site-use browser status
  → 读取 chrome.json，验证 pid 存活 + wsEndpoint 可连
  → 输出："Chrome running (pid 12345, ws://…)" 或 "Chrome not running"
```

### PID 存活检查（跨平台）

```ts
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // signal 0 = 仅检查存在性，不发送信号
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;   // 进程不存在（POSIX）
    if (err.code === 'EPERM') return true;     // 进程存在但无权限（Windows）
    return false;                               // 未知错误，视为已死
  }
}
```

Windows 上 `process.kill(pid, 0)` 在进程存在但调用者无权限时抛出 `EPERM`。
这与 POSIX 不同（POSIX 上同用户进程很少出现 `EPERM`）。以上实现正确处理了两种情况。

### chrome.json 路径

路径：`path.join(config.dataDir, 'chrome.json')` —— 由 `SITE_USE_DATA_DIR`
（默认 `~/.site-use`）决定。暴露为 `config.chromeJsonPath`。

**所有进程（CLI、MCP server、`browser launch`）必须使用相同的 `SITE_USE_DATA_DIR`**
才能正确交接。如果找不到 `chrome.json`，错误信息会包含完整路径，方便用户排查
`SITE_USE_DATA_DIR` 设置不一致的问题。

---

## 跨进程文件锁

### 锁文件

`path.join(config.dataDir, 'op.lock')` —— 内容：`{ "pid": <number>, "startedAt": "<ISO 8601>" }`

### 获取

```
acquireLock(site?: string):
  filename = site ? `op.${site}.lock` : "op.lock"
  path = path.join(config.dataDir, filename)

  1. fs.open(path, O_CREAT | O_EXCL | O_WRONLY)
     ├─ 成功 → 写入 { pid, startedAt }，锁已获取
     └─ EEXIST → 锁文件已存在
         ├─ 读取 pid → isPidAlive(pid)?
         │   ├─ 存活 → 轮询重试（500ms 间隔，30s 超时）
         │   └─ 已死 → 删除过期锁，重试创建
         └─ 读取失败 → 删除损坏的锁文件，重试
```

`O_CREAT | O_EXCL` 在 POSIX 和 Windows（NTFS）上都提供原子性的"不存在则创建"。
对于单用户本地场景足够可靠。

PID 存活检查复用与 Chrome 生命周期相同的跨平台 `isPidAlive()`
（处理 POSIX 的 `ESRCH` 和 Windows 的 `EPERM`）。

### 释放

```
releaseLock():
  1. 删除锁文件
  2. 通过 process.on('exit') + process.on('SIGINT') 注册自动清理
```

### 过期锁恢复

如果进程被 SIGKILL 杀死，`process.on('exit')` 不会触发。
锁文件残留，但下次 `acquireLock()` 会检测到死 PID 并自动清理。

### 未来：按站点粒度

可选的 `site` 参数控制锁文件名：

```
全局（当前）：    ~/.site-use/op.lock
按站点（未来）：  ~/.site-use/op.twitter.lock
                  ~/.site-use/op.reddit.lock
```

需要多站点并发时，传入站点名 `acquireLock(site)`。
Twitter 和 Reddit 即可通过独立锁文件并行操作。

### 与进程内 Mutex 的关系

```
MCP server:
  tool call → withLock(async () => {
    await mutex.run(async () => { 执行 })
  })

  文件锁（withLock）：防止 CLI 同时操作
  进程内 Mutex：      防止 MCP server 内部并发 tool call

CLI:
  命令 → withLock(async () => { 执行 })

  不需要进程内 Mutex（单次执行）
```

**释放顺序：** `withLock` 和 `mutex.run` 各自在 `finally` 中释放。
内层锁（Mutex）先释放，外层锁（文件锁）后释放。
确保不会出现外部进程看到文件锁已释放但内部操作仍在执行的窗口。

---

## CLI Workflow 命令

### 命令结构

```bash
npx site-use <site> <action> [options]
```

二级路由：先站点，后动作。每个站点使用自己的术语。

### Twitter feed

```bash
npx site-use twitter feed --count 50 --tab following
npx site-use twitter feed --tab for_you --json
npx site-use twitter feed --count 20 --debug
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--count` | number (1-100) | 20 | 采集推文数量 |
| `--tab` | `following` \| `for_you` | `following` | 读取哪个 feed 标签页 |
| `--debug` | boolean | false | 包含诊断信息 |
| `--json` | boolean | false | JSON 输出（替代人类可读格式） |

### 执行流程

```
npx site-use twitter feed --count 50 --tab following
  1. 解析参数 → { count: 50, tab: 'following', debug: false, json: false }
  2. result = await withLock(async () => {
       browser = await ensureBrowser()        // connect 模式，autoLaunch=false
       try {
         primitives = 构建 Primitives 装饰器栈
         store = createStore(dbPath)
         try {
           return await getFeed(primitives, count, tab, debug, store)
         } finally {
           store.close()
         }
       } finally {
         browser.disconnect()                 // 保持 Chrome 运行
       }
     })
  3. 输出结果（人类可读 或 --json）
```

`withLock` 内部的 `finally` 块确保正常完成和异常崩溃都能清理资源。
锁的获取/释放由 `withLock` 统一管理，调用方无需手动操作。
如果 CLI 进程被强杀（SIGKILL），`browser.disconnect()` 不会执行，
但 Chrome 内部会处理孤立的 WebSocket 连接 —— 死连接在 Chrome 侧自动清理。
锁文件通过下次 `acquireLock()` 的过期 PID 检测恢复。

### 输出格式

**人类可读（默认，stdout）：**

```
Collected 50 tweets (12 new, 38 duplicates)
Time range: 2026-03-23 16:00 — 2026-03-23 22:32 (UTC+8)

@elonmusk · 2026-03-23 22:32
AI agents are going to reshape how we interact with software...
likes: 42,103  retweets: 8,241
https://x.com/elonmusk/status/1234567890
───────────────────────────────────
...
```

人类可读输出使用用户本地时区（通过 `Intl.DateTimeFormat` 自动检测），
括号标注时区偏移。JSON 输出（`--json`）保持 ISO 8601 UTC 不变。

**JSON（`--json`，stdout）：**

```json
{
  "tweets": [...],
  "ingest": { "inserted": 12, "duplicates": 38, "timeRange": {...} }
}
```

**错误（stderr，退出码 1）：**

```json
{
  "error": "BrowserNotRunning",
  "message": "Chrome not running",
  "hint": "Run 'npx site-use browser launch' first."
}
```

### CLI 路由（`src/index.ts`）

```ts
case 'twitter':
  await runWorkflowCli('twitter', args.slice(1));  // ['feed', '--count', '50', ...]
  break;
```

---

## 重命名：timeline → feed

统一术语：内容流统一称为"feed"，跨所有站点。

### MCP tool

| 之前 | 之后 |
|------|------|
| `twitter_timeline` | `twitter_feed` |
| 参数 `feed: 'following' \| 'for_you'` | 参数 `tab: 'following' \| 'for_you'` |

Breaking change —— 当前用户量少，可接受。

### 内部代码

| 之前 | 之后 |
|------|------|
| `getTimeline()` | `getFeed()` |
| `TimelineResult` | `FeedResult` |
| 参数名 `feed` | 参数名 `tab` |
| `tweetToIngestItems()` | 不变（tweet 是数据单位，不是平台名） |

---

## 文件变更

### 修改

| 文件 | 变更内容 |
|------|---------|
| `src/browser/browser.ts` | `ensureBrowser()` 新增 connect 模式，由 `chrome.json` 驱动。新增 `launchAndDetach()` 供 `browser launch` 使用 |
| `src/server.ts` | `getPrimitives()` 使用 connect 模式。Chrome 未运行时自动 detach 启动。文件锁包裹 Mutex。Tool 重命名 `twitter_feed`，参数 `tab` |
| `src/index.ts` | CLI 路由：新增 `twitter` 二级路由。保留 `search`、`stats`、`browser` 路由 |
| `src/sites/twitter/workflows.ts` | `getTimeline()` → `getFeed()`，参数 `feed` → `tab` |
| `src/sites/twitter/store-adapter.ts` | 清理 timeline 命名引用（如有） |
| `src/config.ts` | 新增 `chromeJsonPath` 便捷属性（小改动） |

### 新增

| 文件 | 职责 |
|------|------|
| `src/cli/workflow.ts` | 浏览器 workflow 的 CLI 入口：解析参数、获取锁、构建 Primitives、执行 workflow、格式化输出、disconnect |
| `src/lock.ts` | 跨进程文件锁：`acquireLock(site?)`、`releaseLock()` |

### 不变

- `src/primitives/` —— 接口及所有装饰器
- `src/storage/` —— 整个模块
- `src/sites/twitter/extractors.ts`
- `src/sites/twitter/matchers.ts`
- `src/sites/twitter/site.ts`
- `src/cli/knowledge.ts`
- `src/mutex.ts` —— 保留，MCP server 内部继续使用

---

## 测试

### 新增测试

| 测试 | 类型 | 验证内容 |
|------|------|---------|
| `browser launch` 写入 chrome.json | unit | 写入正确的 pid + wsEndpoint |
| `browser launch` 幂等性 | unit | Chrome 已运行时不启动第二个，输出提示 |
| `browser close` 清理 | unit | 杀 Chrome + 删 chrome.json；Chrome 未运行时优雅退出 |
| `isPidAlive` 跨平台 | unit | ESRCH → false，EPERM → true，正常 → true |
| `ensureBrowser()` connect 模式 | unit | 读取 `chrome.json`，通过 `puppeteer.connect()` 连接 |
| `ensureBrowser()` chrome.json 不存在 | unit | CLI 抛错，MCP server 自动启动 |
| `ensureBrowser()` chrome.json 过期 | unit | 检测到死 pid，清理 chrome.json |
| connect 后 hook 重放 | unit | `puppeteer.connect()` 后 emulateFocus / applyCoordFix 被调用 |
| 文件锁 获取/释放 | unit | 基本锁生命周期 |
| 文件锁 竞争 | unit | 第二个进程等待，释放后获取 |
| 文件锁 过期清理 | unit | 死 PID 的锁自动清理 |
| 文件锁 SIGKILL 恢复 | unit | 强杀后损坏/残留的锁文件 |
| `withLock` 异常释放 | unit | fn 抛异常 → 锁仍被释放 |
| Chrome 操作中崩溃 | integration | Chrome 被杀 → BrowserDisconnected，browserInstance 置 null，下次可恢复 |
| MCP + CLI 锁协调 | integration | MCP server 持锁中 → CLI 等待 → MCP 释放 → CLI 获锁并成功执行 |
| 用户手动关闭 Chrome 窗口 | integration | Chrome 被用户关闭（非 `browser close`）→ CLI 检测连接失败 → 清晰报错并清理 chrome.json |
| CLI `twitter feed` 集成 | integration | 命令输出格式正确（人类可读 + JSON） |
| CLI `twitter feed` 错误 | integration | Chrome 未运行 → stderr hint + 退出码 1 |
| `twitter_feed` tool 契约 | contract | 参数 `tab`/`count` 合法值 → 返回正确 response 结构（验证重命名后的完整契约） |
| `twitter_feed` tool 错误契约 | contract | Chrome 未运行 → 返回 `isError: true` + 结构化错误 JSON（不是进程崩溃） |
| CLI feed → search 全链路 | e2e | `twitter feed` 采集 → 数据入库 → `search` 找到刚入库的推文（完整数据通路） |

### 修改的测试

| 测试 | 变更 |
|------|------|
| `tests/contract/` | MCP tool 名 `twitter_timeline` → `twitter_feed`，参数 `feed` → `tab` |

### 测试分层与运行

```bash
pnpm test              # 全部（unit + integration + contract）—— 日常开发
pnpm test:unit         # 仅 unit
pnpm test:integration  # 仅 integration
pnpm test:contract     # 仅 contract
pnpm test:e2e          # 仅 e2e —— 需要真实 Chrome，手动触发，不在默认流程中
```

e2e 测试（如"CLI feed → search 全链路"）需要真实浏览器运行，
不会在 `pnpm test` 默认流程中执行，需指定 `pnpm test:e2e` 手动运行。

### 不变的测试

- `tests/integration/storage-*.test.ts`
- `tests/unit/`（已有的非浏览器测试）
