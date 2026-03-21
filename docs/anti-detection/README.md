# 反检测特性评审

> 日期：2026-03-19
> 评审对象：site-use 架构（[设计文档](../site-use-design.md)、[里程碑](../milestones/overview.md)）

评审了三个参考项目：
1. **undetected-chromedriver (UC)** — [详细评审](uc-review.md) | 文档：`d:\src\knowledge\browser-use\undetected-chromedriver-anti-detection-guide.md` | 代码：`d:\src\spider\undetected-chromedriver\` @ `757ed6a`
2. **DrissionPage (DP)** — [详细评审](dp-review.md) | 文档：`d:\src\knowledge\browser-use\drissionpage-anti-detection-guide.md` | 代码：`d:\src\spider\DrissionPage\` @ `4bebd13`
3. **puppeteer-real-browser (PRB)** — [详细评审](prb-review.md) | 文档：`d:\src\knowledge\browser-use\puppeteer-real-browser-architecture-guide.md` | 代码：PRB v1.4.4 @ `510939f`
4. **ghost-cursor** — [轨迹实现对比](ghost-cursor-review.md) | site-use 自研贝塞尔曲线 vs ghost-cursor 的差距分析

---

## site-use 架构约束

| 约束 | 来源 |
|------|------|
| 非 headless 模式（`headless: false`） | [browser.ts:34](../../src/browser/browser.ts#L34)；设计文档："非 headless——用户需要看到操作过程（产品特性，非技术限制）" |
| 真实本地 Chrome（`channel: 'chrome'`） | 设计文档 §browser.ts："使用用户本地安装的 Chrome，不用 Puppeteer 自带的 Chromium" |
| Puppeteer + CDP 直连，不经过 ChromeDriver | 设计文档 §关键架构决策："Puppeteer + CDP 直连，不经过外部 MCP 服务" |
| 持久用户 profile（`~/.site-use/chrome-profile/`） | [config.ts:21](../../src/config.ts#L21)；设计文档 §browser.ts："独立 profile，保持登录态" |
| 跨平台 npm 包（Windows、macOS、Linux） | 设计文档 §技术栈：TypeScript + Node.js + npm |

核心判断依据：site-use 使用**真实 Chrome + Puppeteer CDP 直连**（非 Selenium + ChromeDriver），且运行在**非 headless** 模式。这两个约束排除了大量反检测需求。

---

## 汇总 — UC（18 个 Feature）

| # | Feature | 决定 | 里程碑 | 理由分类 |
|---|---------|------|--------|----------|
| 1 | `cdc_` 二进制补丁 | ❌ 拒绝 | — | Selenium/ChromeDriver 专属 |
| 2 | `navigator.webdriver` Proxy | ⚡ 移除 V1 | M1 ✅ | 引擎层标志已充分覆盖，V1 反而有害 |
| 3 | UA 去 `Headless` | ❌ 拒绝 | — | 非 headless：不适用 |
| 4 | `maxTouchPoints`/`rtt` 伪装 | ❌ 拒绝 | — | 非 headless：不适用 |
| 5 | `window.chrome` 伪造 | ❌ 拒绝 | — | 非 headless：不适用 |
| 6 | `Notification`/`permissions` 伪装 | ❌ 拒绝 | — | 非 headless：不适用 |
| 7 | `toString` 伪装链 | ❌ 拒绝 | — | 依赖 Feature 6 |
| 8 | `--disable-blink-features` | ✅ 采纳 | M1 ✅ | 非 headless 最关键反检测 |
| 9 | `--no-sandbox` + `--test-type` | ⚡ 部分采纳 | M1 ✅ | `--no-sandbox` 仅 Linux；`--test-type` 不默认启用 |
| 10 | `--no-first-run` 等 | ✅ 采纳 | M1 ✅ | 自动化稳定性 |
| 11 | Crash restore 抑制 | ✅ 采纳 | M1 ✅ | 使用 `--hide-crash-restore-bubble` |
| 12 | `--headless=new` 适配 | ❌ 拒绝 | — | 非 headless：不适用 |
| 13 | 进程分离 | ❌ 拒绝 | — | Selenium/ChromeDriver 专属 |
| 14 | `reconnect()` | ❌ 拒绝 | — | Selenium/ChromeDriver 专属 |
| 15 | CDP `tab_new()` | ❌ 拒绝 | — | Puppeteer 已走 CDP |
| 16 | 临时用户目录 | ❌ 拒绝 | — | 设计冲突：需持久 profile |
| 17 | 窗口尺寸 1920×1080 | ✅ 采纳 | M1 ✅ | 标准化 viewport |
| 18 | `--lang` 语言设置 | ✅ 采纳 | M1 ✅ | 三层联动：`--lang` + `--accept-lang` + `fixPreferences` |

### UC 拒绝分类统计

| 分类 | 涉及 Feature | 数量 |
|------|-------------|------|
| **非 headless：不适用** | 3, 4, 5, 6, 7, 12 | 6 |
| **Selenium/ChromeDriver 专属** | 1, 13, 14 | 3 |
| **Puppeteer 已覆盖** | 15 | 1 |
| **设计冲突** | 16 | 1 |
| **依赖被拒绝的 feature** | 7（依赖 6） | 1 |

---

## 汇总 — DP（16 个 Feature）

| # | Feature | 决定 | 里程碑 | 理由分类 |
|---|---------|------|--------|----------|
| 1 | 无 ChromeDriver 架构 | — 无差异 | — | 架构相同 |
| 2 | WebSocket `suppress_origin` | ❌ 拒绝 | — | 无法控制 Puppeteer 内部 WebSocket |
| 3 | `Emulation.setFocusEmulationEnabled` | ✅ 采纳 | M1 ✅ | 一行 CDP 调用，防 `document.hasFocus()` 检测 |
| 4 | `system_user_path` | ❌ 拒绝 | — | 设计冲突：需沙盒隔离 |
| 5 | `new_env` | ❌ 拒绝 | — | 设计冲突：需持久 profile |
| 6 | `auto_port` | — 已覆盖 | — | 随机端口已实现 |
| 7 | 默认启动参数 | ⚡ 部分采纳 | M1 | `--disable-features=PrivacySandboxSettings4` 待实现 |
| 8 | 隐私对话框自动关闭 | ❌ 拒绝 | — | 启动参数已覆盖 |
| 9 | UA 运行时覆写 | ❌ 拒绝 | — | 非 headless：不适用 |
| 10 | HTTP Headers 覆写 | ❌ 拒绝 | — | 不需要 |
| 11 | `add_init_js` | — 已覆盖 | — | Puppeteer 等价能力 |
| 12 | 类人交互模拟 | ✅ 已实现 | — | 贝塞尔轨迹、坐标抖动、遮挡检测、动画等待 |
| 13 | 随机等待 | — 已覆盖 | — | throttle.ts |
| 14 | 网络监听与拦截 | — 已覆盖 | — | `interceptRequest` |
| 15 | URL 阻断 | — 已规划 | M3 | M3 实现时参考 `Network.setBlockedURLs` |
| 16 | 连接已运行浏览器 | ❌ 拒绝 | — | 设计冲突：需沙盒隔离 |

---

## `chrome.runtime` 检测点分析

### 历史背景

Chrome 106（2022-09）之前，Chrome 内置名为 **CryptoToken** 的隐藏组件扩展，它对所有 URL 声明了 `externally_connectable`，因此任何真实浏览器上 `window.chrome.runtime` 都存在。Puppeteer 的 `--disable-extensions` 默认参数会禁用 CryptoToken → `chrome.runtime` 变为 `undefined` → 成为确定性的自动化指纹。

puppeteer-real-browser 等项目正是在这个时期通过"不禁用扩展"来保持 `chrome.runtime` 正常（见 [puppeteer-real-browser 架构文档](file:///D:/src/knowledge/browser-use/puppeteer-real-browser-architecture-guide.md) §3.2）。

### Chrome 106+ 后的变化

Chrome 106 移除了 CryptoToken，`chrome.runtime` 的存在变为取决于三个条件的组合：

1. 用户是否安装了扩展
2. 该扩展的 manifest 是否声明了 [`externally_connectable.matches`](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)
3. 当前页面 URL 是否匹配该 `matches` 模式（不支持全通配 `*://*/*`，至少需要二级域名）

这意味着即使是真实浏览器，在没有匹配扩展的域名上 `chrome.runtime` 也是 `undefined`。该检测点已从**确定性指纹**降级为**统计性信号**。

**参考来源：**
- [chrome.runtime will no longer be defined unconditionally (Chrome 106)](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/tCWVZRq77cg) — Chromium Extensions 官方公告
- [externally_connectable manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable) — Chrome Extensions 文档

### site-use 的处理

- `ignoreDefaultArgs` 中排除 `--disable-extensions`：让用户手动安装的扩展正常工作
- 诊断中标记为 `[INFO]`：仅报告当前值，不判定 pass/fail
- 不尝试通过 stub extension 注入 `chrome.runtime`：`externally_connectable.matches` 不支持全通配，无法覆盖所有目标站点

---

## 诊断验证

所有已实现的反检测特性通过 `--diagnose` 命令验证（12/12 pass）：

```
[PASS] navigator.webdriver                      = false
[PASS] typeof navigator.webdriver               = boolean
[PASS] "webdriver" in navigator                 = true
[PASS] webdriver descriptor                     = {"enumerable":true,"configurable":true}
[PASS] window.chrome exists                     = true
[INFO] window.chrome.runtime exists             = false (depends on extensions)
[PASS] navigator.plugins.length > 0             = true (5)
[PASS] navigator.languages includes en-US       = true (en-US, en)
[PASS] navigator.connection.rtt > 0             = true (200)
[PASS] window.outerWidth                        = 1920
[PASS] window.outerHeight > 0                   = true (1080)
[PASS] document.hasFocus()                      = true
[PASS] document.visibilityState                 = visible
[INFO] Chrome UI overhead                       = 480px (outerHeight - innerHeight)
```

---

## 采纳统计

- **已实现**（13 个）：UC-2（移除 V1）、UC-8、UC-9（部分）、UC-10、UC-11、UC-17、UC-18、DP-3、PRB-L4（坐标修复）、PRB-L5/DP-12（鼠标轨迹 + 坐标抖动）、DP-12（遮挡检测 + 动画等待）
- **M1 待完成**（3 个）：DP-7（启动参数）、PRB-L1（参数精简）、自动化验证
- **M3 待完成**（3 个）：PRB-L3（CDP 痕迹）、DP-15（URL 阻断）、locale/timezone 一致性检查
- **拒绝**（11 UC + 5 DP + 2 PRB）：架构不匹配或设计冲突
- **已覆盖**（5 DP）：Puppeteer 等价能力

---

## 阶段性验证结论（2026-03-20）

### 测试环境

- Chrome 146.0 + Puppeteer CDP 直连，非 headless
- Windows 10，Intel UHD Graphics，1920×1080
- 39 个启动参数（含 Puppeteer 默认参数 + site-use 自定义参数）
- **人工操作**（非自动化脚本）

### 第三方检测结果

| 测试站点 | 结果 | 说明 |
|----------|------|------|
| [browserleaks.com/javascript](https://browserleaks.com/javascript) | ✅ 通过 | 浏览器属性一致，无异常 |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) — Headless | ⚠️ 25% like headless | 误判：`noContentIndex`/`noContactsManager`/`noDownlinkMax` 三个 API 在桌面 Chrome 上本就不存在（Android 专属），非真实泄露 |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) — Resistance | ✅ 全部 unknown | 未检测到反指纹工具或 stealth 插件 |
| [bot.sannysoft.com](https://bot.sannysoft.com) | ✅ 全部通过 | WebDriver/Chrome Object/Selenium/PhantomJS/Debug Tools 全部 pass |
| [nowsecure.nl](https://nowsecure.nl) (Cloudflare) | ✅ Success | 通过 Cloudflare 反机器人检测 |

### 结论

**浏览器指纹层面已达标**：当前 Chrome 配置 + 人工操作可通过全部主流检测站点（含商业级 Cloudflare）。反检测的基础工作（`--disable-blink-features=AutomationControlled`、真实 Chrome、持久 profile、语言/viewport 标准化）已生效。

### 已知风险：启动参数指纹

当前 39 个启动参数中约 17 个来自 Puppeteer 默认参数（如 `--disable-background-networking`、`--disable-client-side-phishing-detection`、`--password-store=basic`、`--use-mock-keychain` 等），这些是已知的自动化框架特征。虽然当前测试站点未因此检测失败，但更严格的检测系统（如参数指纹匹配）可能识别。参考 PRB 的 connect 架构完全绕过了这些参数，site-use 的方案是扩大 `ignoreDefaultArgs` 排除列表（见 Roadmap M1）。

---

## Roadmap

反检测分三个层面逐步推进：**浏览器指纹**（M1 已完成）→ **启动参数精简**（M1 收尾）→ **交互行为 + CDP 痕迹**（M3）。

### M1 — 收尾项

| 优先级 | 项目 | 来源 | 说明 |
|--------|------|------|------|
| **高** | 精简 Puppeteer 默认启动参数 | PRB-L1 | 39 → ~15 个参数，移除 `--disable-background-networking`、`--export-tagged-pdf`、`--use-mock-keychain` 等自动化框架特征参数 |
| **中** | `--disable-features=PrivacySandboxSettings4` | DP-7 | 一个启动参数，阻止隐私沙箱对话框 |
| **中** | 自动化操作通过 nowsecure.nl | — | 当前仅验证了人工操作，需用 site-use 自动化访问验证 |

### M3 — 交互行为模拟

解决"零 mousemove 是最强自动化信号"问题。参考 PRB (ghost-cursor) 和 DrissionPage。

> **Demo:** Run `node scripts/demo-click-comparison.mjs` to see the effect of each enhancement on a diagnostic page. Compares vanilla click, coordinate fix, Bezier trajectory, jitter, occlusion detection, and animation stability wait. Mode 7 验证集成后的 `primitives.click(uid)` 完整管线。
>
> **配置：** 所有增强默认启用，可通过环境变量单独关闭：`SITE_USE_CLICK_TRAJECTORY`、`SITE_USE_CLICK_COORD_FIX`、`SITE_USE_CLICK_JITTER`、`SITE_USE_CLICK_OCCLUSION`、`SITE_USE_CLICK_STABILITY`（设为 `false` 关闭）。

| 优先级 | 项目 | 来源 | 状态 | 说明 |
|--------|------|------|------|------|
| **高** | 鼠标轨迹模拟 | PRB-L5, DP-12 | ✅ 已实现 | 自研贝塞尔曲线，`clickWithTrajectory()` 生成 20-60+ mousemove 事件 |
| **高** | MouseEvent `screenX/screenY` 坐标修复 | PRB-L4 | ✅ 已实现 | `injectCoordFix()` 通过 `evaluateOnNewDocument` 注入，`browser.ts` 自动对所有页面生效 |
| **中** | 点击坐标随机偏移 | PRB-L5, DP-12 | ✅ 已实现 | `applyJitter()` 元素感知比例化偏移（截断正态分布，中心偏向） |
| **中** | 点击遮挡检测 | DP-12 | ✅ 已实现 | `checkOcclusion()` 使用 `DOM.getNodeForLocation`，被遮挡时回退到元素中点 |
| **中** | 元素停止移动检测 | DP-12 | ✅ 已实现 | `waitForElementStable()` 轮询 box model，3 次稳定后点击 |
| **中** | 鼠标轨迹起点：从当前位置出发 | — | 📋 TODO | `clickWithTrajectory()` 起点硬编码为 `(0, random)`，应改为从上次鼠标停留位置出发。连续点击时当前实现会产生不自然的坐标跳跃，是可检测的自动化特征 |

### M3 — CDP 痕迹消除

| 优先级 | 项目 | 来源 | 说明 |
|--------|------|------|------|
| **高** | 评估 rebrowser-puppeteer-core | PRB-L3 | 修补 `Runtime.Enable` 泄漏、`sourceURL` 注入、Utility world 名称暴露三个 CDP 痕迹。API 兼容原版 puppeteer-core，但需评估维护活跃度 |
| **低** | locale/timezone/voices 一致性检查 | — | 诊断系统增强：检测 `en-US` locale 与中文语音/亚洲时区的不匹配 |
| **低** | `Network.setBlockedURLs` | DP-15 | 替代 `setRequestInterception` 的轻量方案 |
