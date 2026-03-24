# 浏览器自动化全景对比

> 生成时间：2026-03-24

覆盖自动化库、反检测方案、AI 浏览器框架三个层面的全景分析，为 site-use 的技术定位和演进路径提供参考。

---

## 1. 自动化库层

### 1.1 总览

| | Playwright | Puppeteer | 裸 CDP | chrome.debugger（扩展） |
|---|---|---|---|---|
| **架构** | 3 进程（Client → Node.js 中继 → Browser） | 2 进程（Client → Browser） | 1 跳 WebSocket | Chrome 内部 API |
| **浏览器支持** | Chrome + Firefox* + WebKit*（*补丁版） | 仅 Chrome | 仅 Chrome | 仅 Chrome |
| **元素定位** | Locator（懒求值、声明式、getByRole 语义） | ElementHandle（DOM 引用，会过期） | 自行实现 | 自行实现 |
| **自动等待** | 内置（可见/稳定/可交互） | 手动 waitForSelector | 自行实现 | 自行实现 |
| **OOPIF** | 开箱即用 | 需手动 Target.setAutoAttach + session 管理 | 手动 | 受限 |
| **弹窗处理** | `page.on('dialog')` | `page.on('dialog')` | 监听 CDP 事件 | 监听 CDP 事件 |
| **CDP 访问** | 旁路，多一跳延迟 | 原生直连 | 就是它本身 | 间接 |
| **stealth 生态** | playwright-stealth（滞后） | puppeteer-extra-plugin-stealth（成熟） | 无 | 不需要 |
| **Runtime.Enable 泄漏** | 有 | 有 | 有 | 无 |
| **npm 周下载量** | ~24.6M | ~6.4M | — | — |
| **适合场景** | E2E 测试、跨浏览器 | 反检测爬虫、轻量自动化 | AI Agent 密集交互 | 真实浏览器遥控 |

### 1.2 血缘关系

Playwright 核心团队（Andrey Lushnikov 等）最初在 Google 创建了 Puppeteer，2020 年跳槽到 Microsoft 后创建了 Playwright。同一批人，不同的设计决策。

```
2017  Google 发布 Puppeteer（Chrome 团队）
        |
2020  核心团队跳槽 Microsoft → 创建 Playwright
        |
2026  两者独立发展，社区逐渐分化
```

### 1.3 核心架构差异

```
Puppeteer（2 进程，~11KB 开销）:          Playwright（3 进程，~326KB 开销）:

  Node.js 进程                              Node.js 进程（Client）
      |                                          |
      | WebSocket（直连 CDP）                     | IPC
      |                                          v
      |                                      Node.js 中继进程
      |                                          |
      v                                          v
    Chrome                                   Chrome / Firefox* / WebKit*
```

Playwright 多出的中继跳增加了每次 CDP 调用的延迟。对 E2E 测试（每个动作少量 CDP 调用）影响可忽略。但对 AI Agent（每个动作数千次 CDP 调用 — DOM 快照、截图、元素查找），延迟累积非常显著。这正是 browser-use 在 2025 年 8 月放弃 Playwright 的原因。

### 1.4 API 设计哲学

**Puppeteer — 命令式，直接 DOM 引用：**
```javascript
const el = await page.waitForSelector('#submit');  // 手动等待
await el.click();                                    // 引用可能过期
```

**Playwright — 声明式，Locator 懒求值：**
```javascript
await page.getByRole('button', { name: 'Submit' }).click();
// 自动等待 + 自动重试 + 不会过期
```

对 AI Agent 场景，Locator 优势不大 — Agent 每次操作前都重新 snapshot，不存在引用过期问题。自动等待有用但可以通过几行 CDP 事件监听实现。

### 1.5 多站点自动化能力矩阵

| 能力 | Playwright | Puppeteer | Puppeteer 下自建工作量 |
|---|---|---|---|
| fallback 定位链 | 部分（Locator 重试，非多策略 fallback） | 无 | 中等 — 构建 backendNodeId → 坐标 → CSS 链 |
| 弹窗处理 | `page.on('dialog')` | `page.on('dialog')` | 极低 — 一个回调 |
| SPA 加载等待 | `networkidle` + `locator.waitFor()` | `networkidle0` + `waitForSelector` | 可能需要自定义 DOM 稳定性检测 |
| OOPIF | 开箱即用 | 需手动 Target.setAutoAttach | **高** — session 管理 + 树合并 |
| 多 tab 追踪 | `context.on('page')` | `browser.on('targetcreated')` | 极低 — 一个事件监听 |
| 崩溃恢复 | 有崩溃事件，无自动恢复 | 有崩溃事件，无自动恢复 | 中等 — 恢复逻辑 |
| 文件下载/上传 | 内置 | 内置 | 极低 |

**OOPIF 是 Puppeteer 下做多站点自动化最大的缺口**，其余都是几行代码的事。

---

## 2. 反检测方案层

### 2.1 总览

| | stealth 插件 | rebrowser | Camoufox | Extension Relay | 行为拟人化 |
|---|---|---|---|---|---|
| **修改层级** | JS 注入 | CDP 协议补丁 | C++ 引擎源码 | 不修改（真实浏览器） | 行为层 |
| **navigator.webdriver** | 覆盖为 false | 不管 | 引擎层改 | 天然 false | 不管 |
| **Runtime.Enable 泄漏** | 不修复 | 修复（核心价值） | 引擎层屏蔽 | 不存在 | 不管 |
| **浏览器指纹** | 部分伪造 | 不管 | 完整伪造 | 完全真实 | 不管 |
| **鼠标/操作拟人** | 不管 | 不管 | 不管 | 不管 | Bezier/抖动/节流 |
| **过 Cloudflare** | 基本不能 | 能 | 能 | 能（真实浏览器） | 辅助 |
| **维护状态** | 社区维护 | **停滞约 10 个月** | 活跃 | 随宿主项目 | 自行实现 |
| **语言** | Node.js | Node.js / Python | 仅 Python | 取决于宿主 | 取决于宿主 |
| **侵入性** | 低（几行代码） | 低（换包名） | 高（换浏览器） | 中（需装扩展） | 中（改操作逻辑） |

### 2.2 检测深度层级

```
检测深度        方案              工作原理
---------------------------------------------------------------
JS 层          stealth 插件      注入 JS 覆盖属性
                                 （navigator.webdriver = false）

CDP 协议层     rebrowser         给 Playwright/Puppeteer 打补丁
                                 修复 Runtime.Enable 泄漏

C++ 引擎层     Camoufox          修改 Firefox C++ 源码并重新编译
                                 指纹数据在到达 JS 引擎之前已被篡改

环境层         Extension Relay   不由自动化库启动浏览器
                                 用户真实浏览器，零自动化标记

行为层         拟人化操作         Bezier 鼠标轨迹、点击抖动、
                                 滚动曲线、操作节流
```

### 2.3 stealth 插件 — 做了什么

一组通过 `evaluateOnNewDocument` 在页面加载前注入的 JS 脚本：

| 补丁项 | 目的 |
|---|---|
| `navigator.webdriver = false` | 最基本的自动化标记 |
| `chrome.runtime` 伪造 | 让网站认为安装了正常扩展 |
| `navigator.plugins` 填充 | 真实 Chrome 有 PDF Viewer 等插件，自动化 Chrome 为空 |
| `WebGL vendor/renderer` 伪造 | 自动化环境可能暴露异常 GPU 信息 |
| `window.chrome` 伪造 | 正常 Chrome 有此对象，Headless 没有 |
| `Function.toString()` 补丁 | 被覆盖函数的 toString() 会暴露非 native code |

**根本局限：** JS 层面的伪装可被高级反 bot 通过属性描述符检查、原型链分析、嵌套 toString() 检测等手段识破。且不修复协议层泄漏。

### 2.4 rebrowser — 当前状态（关键警告）

| 包 | rebrowser 最新版 | 上游最新版 | 滞后幅度 |
|---|---|---|---|
| puppeteer | 24.8.1（2025-05） | 24.40.0（2026-03） | ~10 个月，32 个小版本 |
| playwright | 1.52.0（2025-05） | 1.58.2（2026-03） | ~10 个月，6 个大版本 |

- 单人维护（nwebson），共 27 个 commit，无自动化同步上游机制
- 33 个 open issue 未回复（2025-05 后沉寂）
- 商业公司（rebrowser.net）重心在云浏览器服务，开源补丁是引流产品
- **结论：理解其补丁思路有价值，但不可作为生产依赖**

### 2.5 Camoufox

在 Firefox C++ 层修改指纹数据 — 在数据到达 JS 引擎之前已完成篡改。属性描述符检查、toString() 检查看到的都是"原生"值。

- **仅 Python、仅 Firefox** — 与 Node.js / Chromium 生态不兼容
- 使用 BrowserForge 按真实流量统计分布生成指纹
- 可有效对抗 Cloudflare、DataDome
- 局限：部分 WAF 可检测 SpiderMonkey 引擎特征

### 2.6 Extension Relay（OpenClaw）

不由自动化库启动浏览器。Agent 通过 WebSocket relay 使用 chrome.debugger API 控制用户真实 Chrome。环境完全真实 — 历史记录、书签、插件、cookie 都是真的。

- **设计层面零自动化标记**
- **无行为拟人化** — CDP 命令直接发送，无轨迹/抖动
- 需要用户手动点击扩展图标附加每个标签页

---

## 3. AI 浏览器框架层

### 3.1 总览

| | OpenClaw Browser | site-use | browser-use |
|---|---|---|---|
| **定位** | 通用 Agent 平台的浏览器模块 | 专用 MCP 浏览器工具 | 通用 AI 浏览器框架 |
| **语言** | TypeScript | TypeScript | Python |
| **自动化库** | Playwright Core | puppeteer-core | 裸 CDP（cdp-use，自建） |
| **运行模式** | Host / Sandbox / Extension Relay | 单实例持久化 Chrome | 本地 / 云端 Chrome |
| **页面感知** | Accessibility Tree（Playwright ariaSnapshot） | Accessibility Tree（CDP getFullAXTree） | DOM 快照（CDP，自建） |
| **元素引用** | ref → getByRole Locator | uid → backendNodeId | super-selector（多层 fallback） |
| **OOPIF** | Playwright 内置支持 | 不支持 | 自建 session 管理支持 |
| **弹窗处理** | Playwright 内置 | 未处理 | popups_watchdog |
| **崩溃恢复** | 无 | 无 | crash_watchdog |
| **反检测：环境层** | Extension Relay（零标记） | `--disable-blink-features` | 无内置 |
| **反检测：行为层** | 无拟人化 | Bezier 轨迹 + 抖动 + 节流 | 无内置 |
| **反检测：坐标修复** | 无 | screenX/Y getter 注入 | 无 |
| **反检测：WebRTC** | 无 | 可配置策略 | 无 |
| **反检测：诊断** | 无 | 28+ 项自动检测 | 无 |
| **isTrusted 事件** | true（CDP Input 域） | true（CDP Input 域） | true（CDP Input 域） |
| **登录态** | 借用用户已登录的浏览器 | 持久化 profile，首次手动登录 | 持久化 storage state |
| **无人值守** | 不支持（需用户点击附加） | 支持 | 支持 |
| **远程控制** | 支持（Gateway → Node → Relay） | 不支持（仅本地 stdio） | 支持（云端 CDP） |
| **多 tab** | 手动附加 | 按域名路由 | Target 事件自动追踪 |
| **适合场景** | 真实浏览器遥控 + 远程 Agent | 已知站点拟人化操作 | 任意站点通用自动化 |

### 3.2 页面感知 — 同一基础

三者都基于 **Accessibility Tree** 进行页面感知，差异是表面的：

| | OpenClaw | site-use | browser-use |
|---|---|---|---|
| **API 调用** | `locator.ariaSnapshot()`（Playwright） | `Accessibility.getFullAXTree`（CDP） | DOM 快照（CDP） |
| **底层数据** | Accessibility Tree | Accessibility Tree | DOM + Accessibility |
| **元素 ID 格式** | `e1`、`e2`...（ref） | `1`、`2`...（uid） | super-selector 对象 |
| **解析到 DOM** | getByRole Locator（语义） | backendNodeId（精确） | backendNodeId + 多层 fallback |
| **执行动作** | `locator.click()` → CDP Input.dispatchMouseEvent | `page.mouse.click()` → CDP Input.dispatchMouseEvent | CDP Input.dispatchMouseEvent |

最终的 CDP 命令完全相同。差异在于元素定位方式和是否存在 fallback 策略。

### 3.3 反检测覆盖图

```
                环境检测                      行为检测
           "是不是自动化浏览器?"          "操作像不像人?"

OpenClaw Relay    +++                          ---
site-use          +                            +++
browser-use       ---                          ---
```

OpenClaw Relay 和 site-use 分别解决了反检测的两个对立面。两者结合可同时覆盖两层。

### 3.4 browser-use 的 Playwright → CDP 迁移

**时间线：**
- 2025-04：Playwright → patchright（Playwright 的反检测分支）
- 2025-06：截图改用裸 CDP
- 2025-07：浏览器启动改用 subprocess + CDP
- 2025-08：核心 PR #2573 — 完全移除 Playwright，引入 cdp-use + bubus
- 2025-08-20：博文 "Closer to the Metal: Leaving Playwright for CDP"

**Playwright 在 AI Agent 场景下的问题：**
1. 三层架构多一跳网络延迟 — 每个动作数千次 CDP 调用，延迟累积严重
2. Node.js 中继进程偶发无限期挂起，需 kill -9
3. fullPage 截图在页面超过 16,000px 高度时可靠崩溃
4. 上游拒绝修复 — 这些问题不在 Playwright 的 E2E 测试核心场景内

**新架构：** 15 个独立 watchdog（崩溃、DOM、弹窗、下载、验证码等）基于 bubus EventBus，用显式事件驱动监控替代 Playwright 的隐式行为。

**对 site-use 的启示：** Puppeteer 的 2 进程直连开销远小于 Playwright 的 3 进程中继。需要裸 CDP 的临界点来得晚得多。Puppeteer 仍然是 site-use 当前和近期需求的正确选择。

---

## 4. site-use 多站点能力缺口

从已知站点（Twitter）扩展到任意站点时，需要补齐以下能力：

| 能力 | 当前状态 | Puppeteer 提供 | 需要自建 | 优先级 |
|---|---|---|---|---|
| fallback 定位链 | 单路径，失败即报错 | 不提供 | **是** — backendNodeId → 坐标 → CSS | P0 |
| 弹窗处理 | 未处理 | `page.on('dialog')` | 接上回调即可 | P0 |
| SPA 加载等待 | `waitUntil: 'load'` | `networkidle0` + `waitForSelector` | 可能需要自定义 DOM 稳定性检测 | P0 |
| OOPIF | 不支持 | 需手动 Target.setAutoAttach | **是，工作量大** | P1 |
| 多 tab 追踪 | 固定域名路由 | `browser.on('targetcreated')` | 接上事件监听即可 | P1 |
| 崩溃恢复 | 无 | 有崩溃事件 | **恢复逻辑自建** | P2 |
| 文件下载/上传 | 无 | 内置支持 | 接上即可 | P2 |

### 建议实施路径

```
第一步：fallback 定位链 + 弹窗处理 + SPA 加载等待
        → 覆盖约 80% 的新站点场景

第二步：OOPIF + 多 tab 追踪
        → 覆盖登录/支付/OAuth 流程

第三步：崩溃恢复 + 文件操作
        → 长时间无人值守的健壮性
```

---

## 5. 战略定位

site-use 在全景中占据一个独特的生态位：

```
                    通用型                      站点专用型
                 ┌──────────────────────────┬──────────────────┐
 反检测          │                          │   site-use       │
 导向            │        （空白）           │   （当前）       │
                 ├──────────────────────────┼──────────────────┤
 无反检测        │   browser-use            │   devtools-mcp   │
                 │   OpenClaw Browser        │                  │
                 └──────────────────────────┴──────────────────┘
```

扩展路径是水平方向 — 从站点专用走向通用型，同时保持反检测优势。关键投资是上述 P0/P1 多站点能力，而非切换自动化库。
