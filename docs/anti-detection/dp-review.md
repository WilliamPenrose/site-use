# DrissionPage (DP) 逐 Feature 评审

> 返回 [汇总](README.md)
>
> 参考文档：`d:\src\knowledge\browser-use\drissionpage-anti-detection-guide.md`
> 参考代码：`d:\src\spider\DrissionPage\` @ `4bebd13`

---

### 背景

DrissionPage 与 site-use 在架构上高度相似：**直接 CDP WebSocket 连接 Chrome，不经过 ChromeDriver/Selenium**。因此 UC 中约一半的反检测特性（消除 ChromeDriver 痕迹相关）对两者都不适用。

DP 实现了 16 个反检测特性，本评审重点关注与 site-use 的差异——已被 UC 评审覆盖的同类特性不再重复。

### 架构对比

| 维度 | site-use | DrissionPage |
|------|----------|-------------|
| 控制链路 | Node → Puppeteer → CDP → Chrome | Python → 直接 CDP WebSocket → Chrome |
| ChromeDriver | 不需要 | 不需要 |
| 启动方式 | `puppeteer.launch()` | `Popen()` + 手动 WebSocket 连接 |
| 浏览器 | 真实本地 Chrome，非 headless | 真实本地 Chrome，支持 headless |
| Profile | 独立持久 profile（沙盒隔离） | 支持独立 profile 或直接用系统 profile |

核心结论：两者走同一条技术路线（直接 CDP），反检测基础相当。差异主要在具体细节上。

---

### Feature 1: 无 ChromeDriver 架构

| | |
|---|---|
| **决定** | 无差异 |
| **里程碑影响** | 无 |

site-use 同样不经过 ChromeDriver，直接通过 Puppeteer CDP 连接。UC Feature 1/2/14/15 对两者都不适用。

---

### Feature 2: WebSocket `suppress_origin` — 隐藏 CDP 连接来源

| | |
|---|---|
| **决定** | 拒绝（无法控制） |
| **里程碑影响** | 无 |

**功能**：DrissionPage 在 WebSocket 握手时设置 `suppress_origin=True`，不发送 `Origin` 头，避免暴露连接来自外部自动化工具。

> 来源：[DP 反检测文档 §Feature 2](../../../knowledge/browser-use/drissionpage-anti-detection-guide.md) — `_base/driver.py:159`

**拒绝理由**：Puppeteer 的 CDP WebSocket 连接由内部管理，site-use 无法控制握手参数。且 Puppeteer 的 CDP 连接是进程内的（通过 pipe 或 localhost WebSocket），检测系统监控 CDP WebSocket Origin 头极为罕见。

---

### Feature 3: `Emulation.setFocusEmulationEnabled` — 焦点模拟

| | |
|---|---|
| **决定** | 采纳（待实现） |
| **里程碑影响** | M1 |

**功能**：对每个 tab 初始化时调用 `Emulation.setFocusEmulationEnabled(enabled=true)`，使 `document.hasFocus()` 始终返回 `true`，即使浏览器窗口不在前台。

> 来源：[DP 反检测文档 §Feature 3](../../../knowledge/browser-use/drissionpage-anti-detection-guide.md) — `_pages/chromium_base.py:121`

**采纳理由**：site-use 是非 headless 模式，通常窗口有焦点，但 timeline 采集期间用户可能切到其他窗口。Twitter 等站点可能通过 `document.hasFocus()` 检测非活跃状态。成本极低——tab 初始化时加一行 CDP 调用即可。

**实现位置**：在 Primitives 层（`puppeteer-backend.ts`）创建/获取 page 时，通过 CDP session 调用：

```typescript
const cdp = await page.createCDPSession();
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
```

---

### Feature 4: `system_user_path` — 使用真实用户的浏览器数据

| | |
|---|---|
| **决定** | 拒绝（设计冲突） |
| **里程碑影响** | 无 |

**功能**：不传 `--user-data-dir`，让 Chrome 使用系统默认的用户数据目录，继承用户日常使用的所有数据。

> 来源：[DP 反检测文档 §Feature 4](../../../knowledge/browser-use/drissionpage-anti-detection-guide.md) — `_configs/chromium_options.py:375-376`

**拒绝理由**：site-use 有意使用独立 profile（`~/.site-use/chrome-profile/`）实现沙盒隔离，不影响用户日常浏览。这是[设计文档 §关键架构决策](../site-use-design.md)中的明确选择。

---

### Feature 5: `new_env` — 全新环境启动

| | |
|---|---|
| **决定** | 拒绝（设计冲突） |
| **里程碑影响** | 无 |

**功能**：启动前删除整个用户数据目录，确保全新状态。

**拒绝理由**：site-use 需要持久 profile 保持跨会话登录态。与 UC Feature 16 拒绝理由相同。

---

### Feature 6: `auto_port` — 自动端口与用户数据隔离

| | |
|---|---|
| **决定** | 已覆盖 |
| **里程碑影响** | 无 |

**功能**：多实例并发时自动分配独立端口和用户数据目录。

**已覆盖**：site-use 已使用随机 CDP 端口（`--remote-debugging-port=0`，[browser.ts:49](../../src/browser/browser.ts#L49)）。多实例并发不在 site-use 设计范围内——MCP Server 单进程、Mutex 串行化。

---

### Feature 7: 默认启动参数

| | |
|---|---|
| **决定** | 部分采纳（1 项待实现） |
| **里程碑影响** | M1 |

DrissionPage 的默认启动参数与 site-use 的逐项对比：

| 参数 | site-use | DrissionPage | 评估 |
|------|----------|-------------|------|
| `--no-default-browser-check` | ✅ 已有 | ✅ | — |
| `--no-first-run` | ✅ 已有 | ✅ | — |
| `--hide-crash-restore-bubble` | ✅ 已有 | ✅ | — |
| `--disable-blink-features=AutomationControlled` | ✅ 已有 | ❌ 需手动 | site-use 更好 |
| `--window-size=1920,1080` | ✅ 已有 | ❌ | site-use 更好 |
| `--lang=en-US` | ✅ 已有 | ❌ | site-use 更好 |
| `--disable-infobars` | ❌ | ✅ | **拒绝**——对 headed Chrome 已完全无效（2018 年 Chrome 65 起移除，仅 2024-06 为 headless 部分恢复） |
| `--disable-suggestions-ui` | ❌ | ✅ | 拒绝——功能性参数，非反检测 |
| `--disable-popup-blocking` | ❌ | ✅ | 拒绝——site-use 不依赖弹窗 |
| `--disable-features=PrivacySandboxSettings4` | ❌ | ✅ | **采纳（待实现）**——预防隐私沙盒弹窗干扰自动化 |

**`--disable-features=PrivacySandboxSettings4` 采纳理由**：Chrome 首次启动或使用新 profile 时可能弹出 Privacy Sandbox 隐私声明对话框（`chrome://privacy-sandbox-dialog/notice`），作为独立 tab 出现，会干扰自动化操作。此参数从源头阻止弹窗。

**`--disable-infobars` 拒绝理由**：经调研确认，此参数在 2018 年 Chrome 65 中被 Chromium 团队移除（理由："可被恶意利用"），对 headed Chrome 完全无效。Chrome 静默忽略，不报错也不生效。仅在 2024-06 为 headless Chrome 部分恢复。传了等于没传，只增加代码噪音。

**实现位置**：在 [browser.ts](../../src/browser/browser.ts) 的 `args` 数组中添加：

```typescript
'--disable-features=PrivacySandboxSettings4',
```

---

### Feature 8: 隐私对话框自动关闭

| | |
|---|---|
| **决定** | 拒绝（启动参数已覆盖） |
| **里程碑影响** | 无 |

**功能**：运行时自动检测并关闭 `chrome://privacy-sandbox-dialog/notice` 对话框，通过 CDP 穿透 Shadow DOM 找到确认按钮并点击。

> 来源：[DP 反检测文档 §Feature 8](../../../knowledge/browser-use/drissionpage-anti-detection-guide.md) — `_pages/chromium_base.py:920-951`

**拒绝理由**：采纳 Feature 7 的 `--disable-features=PrivacySandboxSettings4` 后，弹窗从源头被阻止，无需运行时处理。DrissionPage 做双重保障（参数 + 运行时检测）是因为它不能确保用户加了启动参数，而 site-use 自己控制启动参数。

---

### Feature 9: UA 运行时覆写

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**拒绝理由**：site-use 非 headless，UA 天然正常。与 UC Feature 3 拒绝理由相同。

---

### Feature 10: HTTP Headers 覆写

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**拒绝理由**：site-use 不需要动态修改 HTTP 请求头。`Accept-Language` 已通过 `--lang` + `--accept-lang` + `fixPreferences` 三层联动确保一致（UC Feature 18）。

---

### Feature 11: `add_init_js` — 页面初始化脚本注入

| | |
|---|---|
| **决定** | 已覆盖（能力等价） |
| **里程碑影响** | 无 |

**功能**：通过 CDP `Page.addScriptToEvaluateOnNewDocument` 在页面 JS 执行前注入自定义脚本。

**已覆盖**：Puppeteer 的 `page.evaluateOnNewDocument()` 提供完全等价的能力。site-use 可在需要时使用。

---

### Feature 12: 类人交互模拟

| | |
|---|---|
| **决定** | ✅ 已实现 |
| **里程碑影响** | 已完成（原 M3 规划，提前实现） |

DrissionPage 的交互模拟对比（更新于 2026-03-21）：

| 能力 | site-use | DrissionPage | 状态 |
|------|----------|-------------|------|
| 操作间随机延迟 | ✅ throttle.ts | ✅ `wait(min, max)` | ✅ 已覆盖 |
| 点击坐标抖动 | ✅ `applyJitter()` 元素感知比例化偏移 | ✅ 遮挡检测+回退 | ✅ 已实现 |
| 渐进式滚动 | ✅ 3步渐进 | ❌ | ✅ site-use 更好 |
| 逐字输入 | ✅ Puppeteer 内置 | ✅ `interval` 参数 | ✅ 已覆盖 |
| 鼠标轨迹模拟 | ✅ `clickWithTrajectory()` 贝塞尔曲线 | ✅ 线性插值 50ms 步长 | ✅ site-use 更好（曲线 vs 直线） |
| 元素停止移动检测 | ✅ `waitForElementStable()` | ✅ `stop_moving()` | ✅ 已实现 |
| 点击遮挡检测 | ✅ `checkOcclusion()` | ✅ `DOM.getNodeForLocation` | ✅ 已实现（同方案） |

**鼠标轨迹模拟**：site-use 使用自研贝塞尔曲线算法（随机控制点），比 DP 的线性插值更接近真人手部运动。demo 验证 20-60+ mousemove 事件，坐标修复后 screenX/screenY 全部一致。

**所有增强默认启用**，可通过环境变量单独关闭（`SITE_USE_CLICK_TRAJECTORY` 等）。

---

### Feature 13: 随机等待

| | |
|---|---|
| **决定** | 已覆盖 |
| **里程碑影响** | 无 |

site-use 的 throttle.ts 提供操作间随机延迟，功能等价。

---

### Feature 14: 网络监听与拦截

| | |
|---|---|
| **决定** | 已覆盖 |
| **里程碑影响** | 无 |

site-use 的 `interceptRequest` 原语提供等价能力（M1 已实现）。

---

### Feature 15: URL 阻断

| | |
|---|---|
| **决定** | 已规划 |
| **里程碑影响** | M3 |

**功能**：通过 CDP `Network.setBlockedURLs` 阻断特定 URL 请求。

**已规划**：设计文档 M3 已规划广告/追踪域名屏蔽。DP 用 `Network.setBlockedURLs` 比 site-use 规划的 `page.setRequestInterception()` 更轻量（前者不需要拦截每个请求做判断），M3 实现时可参考。

---

### Feature 16: 连接已运行的浏览器

| | |
|---|---|
| **决定** | 拒绝（设计冲突） |
| **里程碑影响** | 无 |

**功能**：连接用户手动启动的、正常使用中的 Chrome 浏览器，获得最大程度的"真实浏览器"伪装。

**拒绝理由**：site-use 选择自己启动 Chrome（独立 profile），这是为了沙盒隔离和用户体验一致性。连接用户日常 Chrome 会导致：(1) 不能同时使用日常 Chrome；(2) 自动化操作可能干扰用户的日常浏览状态。
