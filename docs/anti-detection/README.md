# 反检测特性评审

> 日期：2026-03-19
> 评审对象：site-use 架构（[设计文档](../site-use-design.md)、[里程碑](../milestones/overview.md)）

评审了两个参考项目：
1. **undetected-chromedriver (UC)** — [详细评审](uc-review.md) | 文档：`d:\src\knowledge\browser-use\undetected-chromedriver-anti-detection-guide.md` | 代码：`d:\src\spider\undetected-chromedriver\` @ `757ed6a`
2. **DrissionPage (DP)** — [详细评审](dp-review.md) | 文档：`d:\src\knowledge\browser-use\drissionpage-anti-detection-guide.md` | 代码：`d:\src\spider\DrissionPage\` @ `4bebd13`

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
| 3 | `Emulation.setFocusEmulationEnabled` | ✅ **采纳（待实现）** | M1 | 一行 CDP 调用，防 `document.hasFocus()` 检测 |
| 4 | `system_user_path` | ❌ 拒绝 | — | 设计冲突：需沙盒隔离 |
| 5 | `new_env` | ❌ 拒绝 | — | 设计冲突：需持久 profile |
| 6 | `auto_port` | — 已覆盖 | — | 随机端口已实现 |
| 7 | 默认启动参数 | ⚡ 部分采纳 | M1 | `--disable-features=PrivacySandboxSettings4` 待实现 |
| 8 | 隐私对话框自动关闭 | ❌ 拒绝 | — | 启动参数已覆盖 |
| 9 | UA 运行时覆写 | ❌ 拒绝 | — | 非 headless：不适用 |
| 10 | HTTP Headers 覆写 | ❌ 拒绝 | — | 不需要 |
| 11 | `add_init_js` | — 已覆盖 | — | Puppeteer 等价能力 |
| 12 | 类人交互模拟 | ⚡ 部分差距 | M3 | 鼠标轨迹模拟缺失，M3 跟进 |
| 13 | 随机等待 | — 已覆盖 | — | throttle.ts |
| 14 | 网络监听与拦截 | — 已覆盖 | — | `interceptRequest` |
| 15 | URL 阻断 | — 已规划 | M3 | M3 实现时参考 `Network.setBlockedURLs` |
| 16 | 连接已运行浏览器 | ❌ 拒绝 | — | 设计冲突：需沙盒隔离 |

---

## 待实现项

| 优先级 | Feature | 里程碑 | 实现成本 |
|--------|---------|--------|----------|
| **高** | DP-3: `Emulation.setFocusEmulationEnabled` | M1 | 极低（一行 CDP 调用） |
| **高** | DP-7: `--disable-features=PrivacySandboxSettings4` | M1 | 极低（一个启动参数） |
| **低** | DP-12: 鼠标轨迹模拟 | M3 | 中等（throttle 层增强） |
| **低** | DP-15: `Network.setBlockedURLs` 替代 `setRequestInterception` | M3 | 低（实现方式选择） |

---

## 诊断验证

所有已实现的反检测特性通过 `--diagnose` 命令验证（10/10 pass）：

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
[INFO] Chrome UI overhead                       = 480px (outerHeight - innerHeight)
```

---

## 采纳统计

- **已实现**（7 个）：UC-2（移除 V1）、UC-8、UC-9（部分）、UC-10、UC-11、UC-17、UC-18
- **待实现**（2 个）：DP-3、DP-7
- **拒绝**（11 UC + 5 DP）：架构不匹配或设计冲突
- **已覆盖**（5 DP）：Puppeteer 等价能力
- **未来**（2 个）：DP-12、DP-15（M3）
