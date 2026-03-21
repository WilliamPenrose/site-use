# puppeteer-real-browser vs site-use 反检测能力对比

> **版本**: 2026-03-20
> **对比对象**: puppeteer-real-browser v1.4.4 (`510939f`) vs site-use (当前 `main`)
> **参考文档**: PRB 架构指南、site-use 设计文档 + 反检测 README + UC/DP 评审

---

## 架构差异概览

| 维度 | puppeteer-real-browser (PRB) | site-use |
|------|------------------------------|----------|
| Puppeteer 版本 | `rebrowser-puppeteer-core`（CDP 层反检测补丁） | 原版 `puppeteer-core` |
| 浏览器启动方式 | `chrome-launcher` 独立启动 → `puppeteer.connect()` | `puppeteer.launch()` + `ignoreDefaultArgs` 精选排除 |
| 启动参数策略 | 接管 chrome-launcher `defaultFlags()`，逐条修改 | 接管 Puppeteer `defaultArgs()`，排除 `--enable-automation` 和 `--disable-extensions` |
| headless 策略 | 强制 `false`（`"auto"` → `false`），Linux 用 Xvfb | `headless: false`，无 Xvfb（非服务器场景） |
| 用户 profile | 临时或用户指定 | 持久 profile（`~/.site-use/chrome-profile/`） |
| 定位 | 通用反检测封装库 | 站点自动化 MCP 工具（反检测是手段，不是目的） |

---

## 反检测能力逐项对比

### L1 — 浏览器启动架构

| 能力 | PRB | site-use | 建议 |
|------|-----|----------|------|
| connect 架构（不用 launch） | ✅ chrome-launcher → connect | ❌ 使用 launch | ⚠️ 见下方分析 |
| 排除 `--enable-automation` | ✅ chrome-launcher 不含此参数 | ✅ `ignoreDefaultArgs: ['--enable-automation']` | ✅ 已覆盖 |
| 排除 `--disable-extensions` | ✅ chrome-launcher 不含此参数 | ✅ `ignoreDefaultArgs: ['--disable-extensions']` | ✅ 已覆盖 |
| 排除 Puppeteer 特有参数指纹 | ✅ 完全绕过 `defaultArgs()` | ⚠️ 仅排除 2 个，其余 ~17 个保留 | ⚠️ 见下方分析 |

**connect vs launch 分析：**

PRB 用 `chrome-launcher` → `connect` 的核心优势是完全绕过 Puppeteer 的 `defaultArgs()`，从源头避免 `--export-tagged-pdf`、`--disable-background-networking`、`--force-color-profile=srgb` 等 Puppeteer 特征参数。

site-use 用 `launch()` + `ignoreDefaultArgs` 选择性排除。当前只排除了 2 个最高危的参数，还有约 17 个 Puppeteer 默认参数保留。这些参数单独来看不致命，但组合起来形成"Puppeteer 参数指纹"——有经验的检测系统可以通过命令行参数集合识别。

**建议：不推荐迁移到 connect 架构。** 原因：
1. site-use 已通过当前配置通过 Cloudflare 等主流检测
2. connect 架构引入 `chrome-launcher` 额外依赖，增加复杂度
3. 更好的方案是扩大 `ignoreDefaultArgs` 的排除列表（已在 TODO 中：精简 39 → ~15 个参数）

### L2 — 启动参数反检测（browser 参数部分已验证，简单列出）

| 参数 | PRB | site-use | 状态 |
|------|-----|----------|------|
| `AutomationControlled` 禁用 | `--disable-features=...,AutomationControlled` | `--disable-blink-features=AutomationControlled` | ✅ 两者等效 |
| `--window-size=1920,1080` | ✅ | ✅ | ✅ 已覆盖 |
| `--no-first-run` | ✅ | ✅ | ✅ 已覆盖 |
| `--no-sandbox` (Linux) | ✅ 无条件 | ✅ 仅 Linux | ✅ 已覆盖 |
| `--lang=en-US` | ❌ 未设置 | ✅ 三层联动 | ✅ site-use 更完善 |
| 恢复组件更新 | ✅ 移除 `--disable-component-update` | — launch 无此参数 | — 不适用 |

> **注**: `--disable-features` vs `--disable-blink-features` 的区别——PRB 将 `AutomationControlled` 追加到已有的 `--disable-features` 列表中，比单独用 `--disable-blink-features=AutomationControlled` 更隐蔽（后者是独立的非标准参数，本身可被识别为反检测特征）。但实际检测效果一致，均可通过 `navigator.webdriver === false`。

### L3 — CDP 协议层

| 能力 | PRB | site-use | 建议 |
|------|-----|----------|------|
| `Runtime.Enable` 泄漏修补 | ✅ rebrowser-puppeteer-core | ❌ 原版 puppeteer-core | ⚠️ 推荐关注 |
| `sourceURL` 注入消除 | ✅ rebrowser 补丁 | ❌ 原版 | ⚠️ 推荐关注 |
| Utility world 名称混淆 | ✅ rebrowser 补丁 | ❌ 原版 | ⚠️ 推荐关注 |

**分析：这是 PRB 和 site-use 之间最大的能力差距。**

原版 Puppeteer 的 CDP 通信存在三个已知泄漏：
1. **`Runtime.Enable`**：Puppeteer 连接后立即发送此 CDP 命令，会改变 `Error.stack` 行为，Brotector 等工具可检测
2. **`sourceURL`**：`evaluateOnNewDocument` 注入的脚本带有 `//# sourceURL=pptr:...`，暴露在 `Error().stack` 中
3. **Utility world 名称**：Puppeteer 创建的隔离执行环境名为 `__puppeteer_utility_world__`

`rebrowser-puppeteer-core` 是 Puppeteer 的 fork，专门修补了这三个泄漏点。

**建议：M3 阶段考虑。** 原因：
1. 当前 site-use 已标记 CDP 痕迹为"未验证维度"
2. 替换为 rebrowser-puppeteer-core 是最直接的解决方案，API 兼容
3. 但需评估 rebrowser 的维护活跃度和版本跟进能力
4. 替代方案：自行实现 CDP 通信层修补（成本高，不推荐）

### L4 — JS 运行时注入

| 能力 | PRB | site-use | 建议 |
|------|-----|----------|------|
| MouseEvent `screenX/screenY` 坐标修复 | ✅ `evaluateOnNewDocument` | ✅ 已实现 `injectCoordFix()` | ✅ 已集成到 `browser.ts` + `PuppeteerBackend` |
| `Emulation.setFocusEmulationEnabled` | ❌ 未实现 | ✅ 已实现 | ✅ M1 已完成 |
| `navigator.webdriver` JS 层伪装 | ❌ 不需要（引擎层已禁用） | ❌ 不需要（引擎层已禁用） | ✅ 两者都正确 |

**MouseEvent 坐标修复分析：**

CDP `Input.dispatchMouseEvent` 生成的鼠标事件中，`screenX/screenY` 可能为 0 或与 `clientX/clientY + window.screenX/Y` 不一致。PRB 通过 `evaluateOnNewDocument` 注入 getter 修复此关系。

这是高置信度的自动化信号——真实用户的鼠标事件中，`screenX/Y` 始终等于 `clientX/Y + window.screenX/Y`。

**状态：已实现。** `injectCoordFix()` 在 `browser.ts` 对所有页面自动注入，`PuppeteerBackend.getPage()` 也在创建页面时同步注入，避免 `targetcreated` 竞态。

### L5 — 行为模拟

| 能力 | PRB | site-use | 建议 |
|------|-----|----------|------|
| 贝塞尔曲线鼠标轨迹 | ✅ ghost-cursor | ✅ 自研 `clickWithTrajectory()` | ✅ 已集成 |
| `realClick()` API | ✅ | ✅ `PuppeteerBackend.click()` 默认增强 | ✅ 已集成 |
| 操作节流（随机延迟） | ❌ | ✅ throttle.ts | ✅ site-use 已有 |

**状态：已实现。** 自研贝塞尔曲线算法（`generateBezierPath()`），随机控制点模拟手部运动。`PuppeteerBackend.click()` 默认走增强路径，生成 20-60+ mousemove 事件。另外增加了 `applyJitter()` 元素感知比例化偏移（截断正态分布，bounding box 内中心偏向随机选点）、`checkOcclusion()` 遮挡检测、`waitForElementStable()` 动画等待。所有增强可通过环境变量单独关闭。

### L6 — 挑战求解

| 能力 | PRB | site-use | 建议 |
|------|-----|----------|------|
| Cloudflare Turnstile 自动求解 | ✅ 启发式点击轮询 | ❌ 未实现 | ❌ 不推荐 |
| reCAPTCHA 求解 | ❌ | ❌ | — |

**不推荐的原因：** site-use 的定位是"确定性站点工作流"（Twitter/X 等已知站点），不是通用反检测工具。Turnstile 求解的启发式匹配（扫描 290-310px 宽度的 div）是脆弱的、站点无关的策略，与 site-use 的确定性设计理念冲突。如果特定站点需要 Turnstile 处理，应在 Sites 层针对性实现。

---

## 能力差距优先级排序

| 优先级 | 差距 | PRB 方案 | site-use 方案 | 状态 |
|--------|------|---------|---------------|------|
| **高** | `document.hasFocus()` 检测 | 未覆盖 | `Emulation.setFocusEmulationEnabled`（DP-3） | ✅ M1 已完成 |
| **高** | Puppeteer 默认参数指纹 | connect 架构绕过 | 扩大 `ignoreDefaultArgs` 排除列表 | ⚠️ M1 待完成 |
| **中** | CDP 协议泄漏 | rebrowser-puppeteer-core | 评估替换为 rebrowser 或自研修补 | ⚠️ M3 待完成 |
| **中** | MouseEvent 坐标不一致 | `evaluateOnNewDocument` | `injectCoordFix()` 同方案 | ✅ 已完成 |
| **中** | 鼠标轨迹缺失 | ghost-cursor | 自研 `clickWithTrajectory()` | ✅ 已完成 |
| **低** | `--disable-features` vs `--disable-blink-features` | 追加到已有 flag | 改用 `--disable-features` 方式 | 可选 |

---

## 总结

**site-use 已做好的部分：**
- 启动参数层面的核心反检测（`AutomationControlled` 禁用、扩展保留、语言/viewport 标准化）
- 已通过 Cloudflare、bot.sannysoft.com 等主流检测
- 持久 profile 策略比 PRB 的临时 profile 更适合需要登录态的场景
- 操作节流（throttle.ts）

**PRB 的优势领域：**
- CDP 协议层修补（rebrowser-puppeteer-core）——这是最大差距
- 鼠标行为模拟（ghost-cursor）——M3 优先级
- 完全绕过 Puppeteer 默认参数（connect 架构）——可通过扩大 ignoreDefaultArgs 替代

**不建议从 PRB 引入的：**
- connect 架构——复杂度高，ignoreDefaultArgs 已能解决参数指纹问题
- Turnstile 自动求解——与 site-use 确定性设计理念冲突
- Xvfb 策略——site-use 非服务器场景，不需要
