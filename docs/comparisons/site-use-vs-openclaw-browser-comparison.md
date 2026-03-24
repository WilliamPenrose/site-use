# site-use vs OpenClaw Browser 对比

> 生成时间：2026-03-24

site-use 与 OpenClaw 浏览器模块在架构、反检测、能力取舍方面的详细对比。

---

## 1. 设计哲学

| | site-use | OpenClaw Browser |
|---|---|---|
| **定位** | 以拟人化为核心的专用 MCP 浏览器工具 | 通用 Agent 平台的浏览器控制模块 |
| **核心思路** | 启动专用 Chrome，全链路拟人化 | 桥接用户真实浏览器 OR 托管实例 |
| **反检测策略** | "我看起来像真人"（行为层伪装） | "我就是真人浏览器"（环境层回避） |
| **自动化库** | puppeteer-core（2 进程，CDP 直连） | Playwright Core（3 进程，中继架构） |

---

## 2. 架构

```
site-use:                                OpenClaw Extension Relay:

  Agent（MCP client）                      Agent
    |                                        |
    v                                        v
  MCP Server（stdio）                      Gateway → Relay Server（WS）
    |                                        |
    v                                        v
  puppeteer-core                           Chrome MV3 扩展
    | CDP 直连                               | chrome.debugger API
    v                                        v
  专用持久化 Chrome                         用户日常 Chrome
  (~/.site-use/chrome-profile)             （借用，真实环境）
```

**OpenClaw 还支持另外两种模式：**
- **Host 模式**：Playwright 托管 Chrome（类似 site-use 但用 Playwright）
- **Sandbox 模式**：Docker 容器中的隔离 Chrome

本文聚焦 Extension Relay，因为它代表了最显著的架构差异。

---

## 3. 浏览器环境

| 维度 | site-use | OpenClaw Extension Relay |
|---|---|---|
| **浏览器来源** | 专用 Chrome（隔离 profile，持久化） | 用户日常 Chrome（借用） |
| **登录态** | 首次需手动登录，profile 持久保留 | 用户已登录，天然可用 |
| **Profile 丰富度** | 初期空白，需"养号"积累 | 天然丰富（真实历史/书签/插件/cookie） |
| **无人值守** | 支持（自动启动 Chrome） | 不支持（需用户点击扩展图标附加标签页） |
| **远程控制** | 不支持（仅本地 stdio） | 支持（Gateway → Node → Relay） |
| **多 tab** | 按域名路由（`Map<site, Page>`） | 用户手动通过工具栏按钮附加 |

---

## 4. 页面感知与元素交互

**同一基础，不同封装。**

两者都使用 Accessibility Tree 进行页面感知，使用 CDP Input 域执行动作。最终的 CDP 命令完全相同。

| 维度 | site-use | OpenClaw |
|---|---|---|
| **Snapshot API** | CDP `Accessibility.getFullAXTree` | Playwright `locator.ariaSnapshot()` |
| **底层数据** | Accessibility Tree | Accessibility Tree（相同） |
| **元素 ID 格式** | uid：`1`、`2`、`3`... | ref：`e1`、`e2`、`e3`... |
| **解析到 DOM** | uid → `backendNodeId`（精确） | ref → `getByRole(role, {name})`（语义） |
| **执行动作** | `page.mouse.click(x, y)` | `locator.click()` |
| **最终 CDP 命令** | `Input.dispatchMouseEvent` | `Input.dispatchMouseEvent`（相同） |
| **isTrusted** | true | true |

**定位策略的权衡：**
- site-use 的 `backendNodeId`：精确无歧义，但需要新鲜的 snapshot
- OpenClaw 的 `getByRole`：更耐 DOM 变化（按角色+名称查找），但可能误匹配同名元素

实际上两者每次操作前都重新 snapshot，差异很小。

---

## 5. 反检测对比

### 5.1 环境层

| 检测点 | site-use | OpenClaw Extension Relay |
|---|---|---|
| **navigator.webdriver** | `false`（`--disable-blink-features=AutomationControlled`） | `false`（天然，无自动化启动） |
| **CDP Runtime.Enable 泄漏** | 存在（puppeteer 标准行为） | 不存在（扩展使用 chrome.debugger） |
| **浏览器指纹** | 隔离 profile，可被识别为"新设备" | 完全真实（用户积累的环境） |
| **Chrome 启动参数** | 有自动化相关参数 | 无启动参数（用户正常启动 Chrome） |

### 5.2 行为层

| 检测点 | site-use | OpenClaw Extension Relay |
|---|---|---|
| **鼠标轨迹** | Bezier 曲线 + Fitts 定律 + 过冲修正 | 无（裸 CDP 命令） |
| **点击拟人** | 位置稳定等待 + 遮挡检测 + ±3px 抖动 | 无 |
| **滚动拟人** | 钟形速度曲线 + ±20% 步长抖动 | 无 |
| **操作节奏** | 2-5s 随机间隔 + 滑动窗口限速 | 无 |
| **screenX/Y 坐标修复** | MouseEvent getter 注入 | 无 |
| **WebRTC 防泄漏** | 可配置策略（disable/public_only/off） | 无 |
| **诊断工具** | 28+ 项自动化反检测检查 | 无 |

### 5.3 覆盖图

```
              环境检测                    行为检测
           "是不是自动化浏览器?"       "操作像不像人?"

site-use           +                         +++
OpenClaw Relay     +++                       ---
两者结合            +++                       +++
```

两者解决的是反检测的两个对立面。理想方案：Extension Relay 提供真实浏览器环境 + site-use 的拟人化逻辑提供行为真实性。

---

## 6. 多站点场景的健壮性

| 能力 | site-use | OpenClaw |
|---|---|---|
| **fallback 定位链** | 无 — 单路径（backendNodeId），失败即报错 | 无 — 单路径（Locator） |
| **弹窗处理** | 未处理 | Playwright 内置 |
| **SPA 加载等待** | `waitUntil: 'load'` | Playwright auto-wait + networkidle |
| **OOPIF（跨域 iframe）** | 不支持 | Playwright 内置支持 |
| **多 tab 追踪** | 固定域名路由 | 手动附加，但 Playwright 处理新页面 |
| **崩溃恢复** | 无 | 无 |
| **文件下载/上传** | 无 | Playwright 内置 |

OpenClaw 在这方面受益于 Playwright 更丰富的内置能力。site-use 要扩展到多站点需要自建其中若干能力（详见 browser-automation-landscape.md §4）。

---

## 7. 连接与认证

| | site-use | OpenClaw Extension Relay |
|---|---|---|
| **传输** | MCP over stdio（本地进程） | HTTP + WebSocket（relay server） |
| **认证** | 无（本地 IPC，不走网络） | HMAC-SHA256 token（`x-openclaw-relay-token`） |
| **网络暴露** | 无 | 仅 loopback（127.0.0.1），可配置为 0.0.0.0（WSL2） |
| **容错** | `ensureBrowser()` 重连 | 扩展 WS 断开后 20s 宽限期，标签页重附加 5 次重试 |

---

## 8. 用户数据安全对比

两者在用户数据安全上存在**根本性差异**：site-use 的隔离 profile 是一个沙箱，Extension Relay 则是让 Agent 直接操作用户真实环境。

### 8.1 威胁模型

| | site-use（隔离 Chrome） | OpenClaw Extension Relay（真实浏览器） |
|---|---|---|
| **Agent 操作的环境** | 专用隔离 profile（`~/.site-use/chrome-profile`） | 用户日常 Chrome（真实 cookie、登录态、历史） |
| **最坏情况后果** | 隔离 profile 被搞乱，重建即可 | 用户真实账号被误操作，**不可逆** |
| **爆炸半径** | 仅限隔离 profile 内的数据 | 所有已附加标签页的真实数据 |

### 8.2 风险场景对比

| 风险场景 | site-use | OpenClaw Extension Relay |
|---|---|---|
| Agent 幻觉，导航到钓鱼网站 | 隔离 profile 无真实 cookie 可偷 | 用户真实 cookie 暴露给钓鱼页面 |
| Prompt injection 诱导 Agent 执行恶意 JS | 只能读隔离 profile 的 localStorage | 可读用户所有已附加标签页的数据 |
| Agent 误操作点了"删除账号" | 隔离 profile 的账号，非用户主账号 | **用户真实账号** |
| Agent 截图发给 LLM 分析 | 隔离环境的页面内容 | 可能包含邮件、聊天记录、银行余额 |
| Relay token 泄漏 | 不适用 | 任何本地进程可控制用户浏览器 |

### 8.3 OpenClaw 的缓解措施

OpenClaw 通过多层机制降低风险**概率**：

| 缓解措施 | 说明 |
|---|---|
| 手动附加 | 用户必须点击扩展图标才能让 Agent 控制该标签页 |
| Tab 隔离 | 只有主动附加的标签页才能被操控 |
| HMAC 认证 | 防止非授权进程连接 relay |
| Loopback 绑定 | relay 仅监听 127.0.0.1 |
| 用户可随时断开 | 再点一次扩展图标即 detach |
| SSRF 防护 | 阻止导航到私有网络/file:// 等危险 URL |
| JS 执行开关 | `evaluateEnabled` 可关闭任意 JS 执行 |
| CSRF 防护 | Origin/Referer 验证，防跨域请求 |

但这些降低的是**概率**，不降低**后果的严重性**。site-use 的隔离 profile 是在**后果层面**兜底 — 即使最坏情况发生，损失也是有限的。

### 8.4 安全性跷跷板

反检测安全与用户数据安全之间存在根本 trade-off：

```
              反检测安全              用户数据安全
           （对网站的隐蔽性）        （Agent 失控的后果）

site-use         +                       +++
OpenClaw Relay   +++                     +
```

对网站越隐蔽（真实浏览器 → 真实数据暴露），对用户越危险。这个跷跷板无法消除，只能通过缓解措施在两端之间取得平衡。

---

## 9. 优劣势总结（含安全维度）

### site-use

| 优势 | 劣势 |
|---|---|
| 完整的行为拟人化（Bezier、抖动、节流） | Runtime.Enable CDP 泄漏（可被 Cloudflare/DataDome 检测） |
| **隔离 profile — Agent 失控时爆炸半径小** | 新 profile 指纹可能触发"新设备"风控 |
| 无人值守运行 | 不支持 OOPIF |
| 28+ 项反检测诊断 | 仅本地，无远程控制 |
| CDP 直连（puppeteer，低延迟） | 未处理弹窗 |
| screenX/Y 坐标修复 | 单路径元素定位（无 fallback） |
| WebRTC 防泄漏 | |

### OpenClaw Extension Relay

| 优势 | 劣势 |
|---|---|
| 零自动化标记（真实浏览器） | **Agent 操作用户真实环境 — 失控后果严重** |
| 无 Runtime.Enable 泄漏 | 无行为拟人化 |
| 完全真实的指纹 + 登录态 | 需用户手动附加标签页 |
| 通过 Gateway 远程控制 | 无法无人值守运行 |
| Playwright 内置 OOPIF/弹窗/下载 | 无 screenX/Y 坐标修复 |
| 多层安全机制（SSRF/认证/CSRF/Tab 隔离） | 3 进程 Playwright 架构（更高延迟） |

---

## 10. 各自的甜区

**site-use 最适合：**
- 在已知或逐步扩展的站点集上进行无人值守自动化
- 需要行为层反检测的场景（鼠标轨迹、操作节奏）
- 单用户、单机部署

**OpenClaw Extension Relay 最适合：**
- 利用用户已有的登录态和浏览器环境
- 绕过环境层检测（指纹、Runtime.Enable）
- 远程 Agent 控制用户本地浏览器
- 用户在场且可以交互的场景

---

## 11. 互补整合潜力

两种方案是互补而非竞争关系：

| 层面 | site-use 提供 | OpenClaw Relay 提供 |
|---|---|---|
| 环境真实性 | 部分（需要养号） | 完整（真实浏览器） |
| 行为真实性 | 完整（Bezier、抖动、节流） | 无 |
| 无人值守能力 | 有 | 无 |
| 远程控制能力 | 无 | 有 |

**结合方案：** 使用 Extension Relay 提供真实浏览器环境（通过环境检测）+ site-use 的拟人化逻辑提供行为真实性（通过行为检测），即可同时覆盖两层检测。
