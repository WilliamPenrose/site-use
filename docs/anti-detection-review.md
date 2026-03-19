# 反检测特性评审：undetected-chromedriver vs site-use

> 日期：2026-03-19
> 来源文档：`d:\src\knowledge\browser-use\undetected-chromedriver-anti-detection-guide.md`
> 来源代码：`d:\src\spider\undetected-chromedriver\` @ commit `757ed6a` (master)
> 评审对象：site-use 架构（[设计文档](site-use-design.md)、[里程碑](milestones/overview.md)）

## 背景

undetected-chromedriver 实现了 18 个反检测特性，针对的是 Selenium/ChromeDriver 自动化架构。本评审逐一检查每个特性是否适用于 site-use，给出采纳或拒绝的决定及理由。

### site-use 架构约束

| 约束 | 来源 |
|------|------|
| 非 headless 模式（`headless: false`） | [browser.ts:34](../src/browser/browser.ts#L34)；[设计文档](site-use-design.md)："非 headless——用户需要看到操作过程（这是产品特性，不是技术限制）" |
| 真实本地 Chrome（`channel: 'chrome'`） | [设计文档 §browser.ts](site-use-design.md)："使用用户本地安装的 Chrome，不用 Puppeteer 自带的 Chromium" |
| Puppeteer + CDP 直连，不经过 ChromeDriver | [设计文档 §关键架构决策](site-use-design.md)："Puppeteer + CDP 直连，不经过外部 MCP 服务" |
| 持久用户 profile（`~/.site-use/chrome-profile/`） | [config.ts:21](../src/config.ts#L21)；[设计文档 §browser.ts](site-use-design.md)："独立 profile，保持登录态" |
| 跨平台 npm 包（Windows、macOS、Linux） | [设计文档 §技术栈](site-use-design.md)：TypeScript + Node.js + npm 包 |

核心判断依据：site-use 使用**真实 Chrome + Puppeteer CDP 直连**（非 Selenium + ChromeDriver），且运行在**非 headless** 模式。这两个约束排除了大量反检测需求。

---

## 逐 Feature 评审

### Feature 1: `cdc_` 二进制补丁

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：修补 ChromeDriver 二进制文件，消除其向 `window` 注入的 `cdc_` 开头全局变量（如 `cdc_adoQpoasnfa76pfcZLmcfl_Array`）。这是最经典的 Selenium 检测信号。

> 来源：[反检测文档 §Feature 1](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `patcher.py:366-394`

**拒绝理由**：site-use 使用 Puppeteer 而非 Selenium/ChromeDriver。反检测文档明确指出：

> "在 Node.js 生态中（Puppeteer/Playwright）不经过 chromedriver，直接通过 CDP 连接浏览器，因此不存在 `cdc_` 变量注入问题。此 feature 仅与 Selenium/ChromeDriver 架构相关。"
>
> — [反检测文档 §Feature 1「Node/TypeScript CDP 实现」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

无 ChromeDriver 二进制 → 无 `cdc_` 注入 → 无需补丁。

---

### Feature 2: `navigator.webdriver` Proxy 伪装

| | |
|---|---|
| **决定** | 移除 V1（引擎层标志已充分覆盖） |
| **里程碑影响** | M1 ✅ |

**功能**：用 `Proxy` 包装 `navigator` 对象，同时拦截 `get` 和 `has` 操作，使 `navigator.webdriver` 和 `"webdriver" in navigator` 均返回 `false`。

> 来源：[反检测文档 §Feature 2](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:496-517`

**原有实现**：曾使用 V1 方案（`Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`），已移除。

**移除理由**：通过 `--diagnose` 诊断命令实测证明，V1 方案不仅冗余，而且**有害**：

1. `Object.defineProperty` 产生 `undefined`（而非 `false`）——真实浏览器中 `navigator.webdriver` 应为 `false`（boolean），`undefined` 本身是异常信号
2. 产生的 property descriptor 为 `{enumerable: false, configurable: false}`——真实浏览器原生属性为 `{enumerable: true, configurable: true}`，这又是一个可检测的异常

引擎层标志（`--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs: ['--enable-automation']`）已从 Blink 层面原生设置 `navigator.webdriver = false`，无需 JS 层面干预。诊断验证结果：

```
[PASS] navigator.webdriver                      = false
[PASS] typeof navigator.webdriver               = boolean
[PASS] "webdriver" in navigator                 = true
[PASS] webdriver descriptor                     = {"enumerable":true,"configurable":true}
```

**未来**：如果增加 headless 支持，需重新评估是否需要 Proxy 方案（V2）。

---

### Feature 3: User-Agent 去除 `Headless` 标记

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：通过 CDP `Network.setUserAgentOverride` 将 UA 中的 `HeadlessChrome` 替换为 `Chrome`。

> 来源：[反检测文档 §Feature 3](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:519-527`

**拒绝理由**：site-use 运行 `headless: false`（[browser.ts:34](../src/browser/browser.ts#L34)）。反检测文档明确指出：

> "仅 headless 模式激活；非 headless 模式 UA 本身不含 `Headless`，无需处理"
>
> — [反检测文档 §Feature 3「推导·注意事项」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

---

### Feature 4: `navigator.maxTouchPoints` / `navigator.connection.rtt` 伪装

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：覆写 `maxTouchPoints`（0 → 1）和 `connection.rtt`（0 → 100），这些值在 headless 模式下异常。

> 来源：[反检测文档 §Feature 4](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:532-533`

**拒绝理由**：这些值仅在 headless 模式下异常。反检测文档说明该功能仅在 `_configure_headless()` 内部激活（`__init__.py:488-489`）。非 headless 的真实 Chrome 返回真实硬件值，无需伪造。

---

### Feature 5: `window.chrome` 运行时对象伪造

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：注入一个完整的 `window.chrome` mock 对象（含 `app`、`runtime` 子对象及枚举值），模拟真实 Chrome 的结构。

> 来源：[反检测文档 §Feature 5](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:536-591`，代码来源标注为 `microlinkhq/browserless`

**拒绝理由**：`window.chrome` 仅在 headless Chrome 中缺失或不完整。site-use 使用真实非 headless Chrome，`window.chrome` 原生存在且结构完整（包含 `chrome.runtime.sendMessage` 等方法）。反检测文档也指出此 mock 仅是"结构骨架"：

> "这只是结构骨架，真实 Chrome 的 `chrome.runtime` 还有 `sendMessage`、`connect` 等方法；如果检测系统调用这些方法，此 mock 会抛异常暴露"
>
> — [反检测文档 §Feature 5「推导·注意事项」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

---

### Feature 6: `Notification` / `permissions.query` 伪装

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：创建 `window.Notification` stub 并劫持 `navigator.permissions.query` 的 `notifications` 查询——headless Chrome 下这两者行为异常。

> 来源：[反检测文档 §Feature 6](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:594-604`，代码来源标注为 `microlinkhq/browserless` 的 `navigator-permissions.js`

**拒绝理由**：非 headless Chrome 原生支持 `Notification` 且 `permissions.query` 行为正常，无需伪装。

---

### Feature 7: `Function.prototype.toString/call` 伪装

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：替换 `Function.prototype.toString` 和 `Function.prototype.call`，使 Feature 6 中被劫持的函数在 `.toString()` 时返回 `[native code]`，避免被检测系统识破。

> 来源：[反检测文档 §Feature 7](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:606-625`

**拒绝理由**：此特性的唯一目的是掩盖 Feature 6 的函数劫持痕迹。site-use 不做 Feature 6 的劫持，因此不需要掩盖。反检测文档明确了这种依赖关系：

> "此伪装链只覆盖了 `permissions.query` 一个函数（`__init__.py:616`）；如果你新增了其他函数劫持，需要在 `functionToString` 中添加对应分支"
>
> — [反检测文档 §Feature 7「推导·注意事项」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

无劫持 → 无需掩盖。

---

### Feature 8: `--disable-blink-features=AutomationControlled`

| | |
|---|---|
| **决定** | 采纳（已实现） |
| **里程碑影响** | M1 ✅ |

**功能**：关闭 Blink 引擎的 `AutomationControlled` 特性标志。此标志的影响不仅限于 `navigator.webdriver = true`，还包含引擎内部不可见、不可通过 JS 覆盖的自动化信号。

> 来源：[反检测文档 §Feature 8](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

**当前实现**：[browser.ts:19](../src/browser/browser.ts#L19)：

```typescript
'--disable-blink-features=AutomationControlled',
```

配合 [browser.ts:36](../src/browser/browser.ts#L36)：

```typescript
ignoreDefaultArgs: ['--enable-automation'],
```

**为什么这是非 headless 模式下最关键的反检测手段**：反检测文档记录了一个实测结论，证明 JS 层面的伪装不充分：

> "**实测验证**：仅通过 CDP 在 JS 层面伪装 `navigator.webdriver` 返回 `false` → **无法通过 Google 登录检测**。Google 仍能识别自动化环境。而使用启动参数 `--disable-blink-features=AutomationControlled` → **可以正常登录 Google**。这证明：**JS 层伪装 ≠ 引擎层关闭**。`AutomationControlled` flag 控制的信号远不止 `navigator.webdriver` 一个属性。"
>
> — [反检测文档 §Feature 8「针对的检测场景」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

**副作用**：反检测文档指出 Chrome 会显示警告横幅："您使用的是不受支持的命令行标记：--disable-blink-features=AutomationControlled。稳定性和安全性会有所下降。" 文档推测这可能是 undetected-chromedriver 没有自动添加此参数的原因——警告横幅本身也是检测信号。

---

### Feature 9: `--no-sandbox` + `--test-type` 信息栏抑制

| | |
|---|---|
| **决定** | 部分采纳：`--no-sandbox` 仅 Linux；`--test-type` 不默认启用 |
| **里程碑影响** | M1 ✅ |

**功能**：`--no-sandbox` 允许 Chrome 以 root 身份在 Linux 上运行（Docker/CI 环境常见需求）。`--test-type` 抑制 Chrome 的命令行标记警告信息栏。

> 来源：[反检测文档 §Feature 9](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:395-396`，以及 `__init__.py:412` 无条件添加 `--no-sandbox` 的注释说明

**`--no-sandbox` 采纳理由**：site-use 是跨平台 npm 包。在 Linux 上（尤其是以 root 运行的 Docker 容器中），Chrome 必须有 `--no-sandbox` 才能启动。仅在 Linux 上添加。

**`--test-type` 不默认启用**：实测确认 `--test-type` 可以抑制 `--disable-blink-features=AutomationControlled` 引发的黄色警告横幅（"您使用的是不受支持的命令行标记"）。但进一步调研发现，`--test-type` 不只是隐藏 banner——它会改变 Chrome 的内部运行模式，Chromium 开发者提到该参数有"很多有趣的副作用"，可能影响安全性和稳定性。

| 方案 | 风险 |
|------|------|
| 只用 `--disable-blink-features=AutomationControlled` | 仅显示 banner，无功能影响 |
| 加上 `--test-type` 隐藏 banner | 进入测试模式，有潜在安全/稳定性影响 |

因此 `--test-type` 不作为默认参数。用户如觉得 banner 烦扰，可通过 CLI 透传：

```bash
site-use browser launch --test-type
```

**实现**：

```typescript
// --no-sandbox: Linux/Docker only
if (process.platform === 'linux') {
  args.push('--no-sandbox');
}

// --test-type: not included by default (suppresses infobar but enters test mode)
// Users can pass it via CLI: site-use browser launch --test-type
```

---

### Feature 10: `--no-default-browser-check` + `--no-first-run`

| | |
|---|---|
| **决定** | 采纳（已实现） |
| **里程碑影响** | M1 ✅ |

**功能**：抑制"设为默认浏览器"对话框和首次运行欢迎页面，这些弹窗会导致 WebDriver 连接超时。

> 来源：[反检测文档 §Feature 10](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:393-394`

**当前实现**：[browser.ts:17-18](../src/browser/browser.ts#L17-L18)：

```typescript
'--no-first-run',
'--no-default-browser-check',
```

反检测文档强调其对稳定性的影响：

> "如果不抑制欢迎界面，浏览器可能因为弹窗超时而丢失连接并抛异常"
>
> — [反检测文档 §Feature 10](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)，引用 docstring `__init__.py:211-215`

---

### Feature 11: `exit_type` 标记修复

| | |
|---|---|
| **决定** | 采纳（已实现，扩展为 `fixPreferences`） |
| **里程碑影响** | M1 ✅ |

**功能**：在 Chrome 启动前修改用户 profile 中 `Default/Preferences` 文件的 `profile.exit_type` 为 `null`，防止"Chrome 未正确关闭——恢复页面？"提示。

> 来源：[反检测文档 §Feature 11](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:424-440`

**采纳理由**：site-use 使用持久 Chrome profile（[config.ts:21](../src/config.ts#L21)：`path.join(dataDir, 'chrome-profile')`）。用户可能直接关闭 Chrome 窗口或强制退出，导致 `exit_type` 被设为非 null 值。下次启动时恢复提示会：

1. 干扰自动导航（页面恢复到之前的 URL，而非预期目标）
2. 可能导致 `takeSnapshot()` 捕获恢复栏而非实际页面内容

**实现**（来自反检测文档提供的 TypeScript 参考代码）：

```typescript
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function fixExitType(userDataDir: string) {
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  try {
    const config = JSON.parse(readFileSync(prefsPath, 'latin1'));
    if (config.profile?.exit_type != null) {
      config.profile.exit_type = null;
      writeFileSync(prefsPath, JSON.stringify(config), 'latin1');
    }
  } catch {
    // Preferences 文件在新 profile 中可能不存在
  }
}
```

> 来源：[反检测文档 §Feature 11「Node/TypeScript 实现」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

在 `ensureBrowser()` 中 `puppeteer.launch()` 之前调用。

**实际实现**：扩展为 `fixPreferences()`，同时处理 `exit_type` 修复和语言强制设置（Feature 18 联动）。将 `exit_type` 设为 `'Normal'`（而非原始文档的 `null`），同时将 `intl.accept_languages` 强制设为 `'en-US,en'`。详见 [browser.ts](../src/browser/browser.ts) 中的 `fixPreferences()` 函数。

---

### Feature 12: Headless 版本适配 `--headless=new`

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：根据 Chrome 版本自动选择 `--headless=chrome`（< v108）或 `--headless=new`（≥ v108）。

> 来源：[反检测文档 §Feature 12](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:398-408`

**拒绝理由**：site-use 使用 `headless: false`（[browser.ts:34](../src/browser/browser.ts#L34)），不涉及 headless 模式选择。

---

### Feature 13: 浏览器进程分离

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：通过中间 daemon 进程启动 Chrome 作为"孙进程"，使 Chrome 与 Python/ChromeDriver 没有父子关系。检测系统检查 Chrome 的父进程时不会发现 `chromedriver.exe` 或 `python.exe`。

> 来源：[反检测文档 §Feature 13](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:447-459`，`dprocess.py:18-43`

**拒绝理由**：site-use 通过 Puppeteer 的 `puppeteer.launch()` 启动 Chrome，内部使用 `child_process.spawn`。Chrome 的父进程是 `node.exe`——这与 Electron 应用、VS Code 或任何嵌入 Chrome 的 Node.js 应用无异。父进程检测针对的是 `chromedriver.exe` 和 `python.exe`，而非 `node.exe`。额外的进程分离增加了生命周期管理复杂度（PID 追踪、清理等），收益不大。

---

### Feature 14: `reconnect()` — ChromeDriver 会话断开重连

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：停止 ChromeDriver 服务 → 等待 → 重启 → 重建会话。在检测窗口期间临时移除 ChromeDriver 进程。

> 来源：[反检测文档 §Feature 14](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:705-719`

**拒绝理由**：反检测文档明确指出此功能在 Puppeteer/Playwright 中无等效：

> "无直接等效。这是 Selenium WebDriver 层面的操作——断开 chromedriver 进程再重连。在 Puppeteer/Playwright 中，浏览器连接是直接 CDP WebSocket，没有中间的 driver 进程可以断开。"
>
> — [反检测文档 §Feature 14「Node/TypeScript CDP 实现」](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md)

---

### Feature 15: CDP `tab_new()` 绕过 WebDriver 命令链路

| | |
|---|---|
| **决定** | 拒绝 |
| **里程碑影响** | 无 |

**功能**：通过 Chrome 的 `/json/new?{url}` HTTP 调试接口打开新标签页，绕过 WebDriver 命令链路的检测。

> 来源：[反检测文档 §Feature 15](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:686-703`，`cdp.py:72-73`

**拒绝理由**：site-use 的所有操作已经完全通过 CDP 执行。Puppeteer 的 `page.goto()`、`page.click()`、`page.evaluate()` 等全部是 CDP 命令直接发送到 Chrome，从不经过 WebDriver 协议。不存在需要绕过的 WebDriver 命令链路。

---

### Feature 16: 临时用户数据目录 + 自动清理

| | |
|---|---|
| **决定** | 拒绝（设计冲突） |
| **里程碑影响** | 无 |

**功能**：通过 `tempfile.mkdtemp()` 创建临时 Chrome profile，退出时自动删除，每次会话使用干净状态。

> 来源：[反检测文档 §Feature 16](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:349-357`（创建），`__init__.py:778-796`（清理）

**拒绝理由**：与 site-use 设计直接冲突。site-use 需要**持久 profile** 来：

1. 跨会话保持登录态（用户手动登录 Twitter 一次，后续会话复用 cookies）
2. 自然积累浏览历史、cookies、localStorage——使 profile 看起来像真实用户

> "独立 profile 在首次登录后自然积累 cookies/localStorage"
>
> — [设计文档 §反爬策略第 1 层](site-use-design.md)

反检测文档本身也记录了持久 profile 的场景："如果用户通过 `user_data_dir` 参数指定了目录，`keep_user_data_dir` 会被设为 `True`，退出时不会清理"（`__init__.py:298`、`__init__.py:322`）。site-use 始终使用指定的数据目录（[config.ts:21](../src/config.ts#L21)）。

---

### Feature 17: 窗口尺寸标准化 1920×1080

| | |
|---|---|
| **决定** | 采纳（已实现） |
| **里程碑影响** | M1 ✅ |

**功能**：设置 `--window-size=1920,1080`，避免自动化浏览器的默认窗口尺寸异常。

> 来源：[反检测文档 §Feature 17](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:410-411`

**采纳理由**：当前 [browser.ts](../src/browser/browser.ts) 未设置窗口尺寸。虽然非 headless Chrome 继承操作系统默认值，但在首次启动新 profile 时（无保存的窗口位置），窗口大小可能不确定。标准化为 1920×1080 确保：

1. `screenshot()` 输出一致，不受用户显示器影响
2. 不会出现异常小 viewport 被检测系统标记
3. 页面在标准断点下渲染（多数网站针对 1920px 宽度优化）

**跨层影响**：虽然实现在 Browser 层，但 viewport 尺寸影响上层行为：
- **Primitives 层**：`takeSnapshot()` 获取的辅助功能树中可见元素数量取决于 viewport（响应式布局下小屏可能隐藏某些元素）；`screenshot()` 输出尺寸变得确定
- **Sites 层**：`scroll` 每次加载的内容量取决于 viewport 高度

这些影响是正面的——标准化 viewport 让上层行为更可预测，**上层无需适配代码变动**。

**实现**：在 [browser.ts](../src/browser/browser.ts) 的启动参数中添加：

```typescript
'--window-size=1920,1080',
```

注：不使用 `--start-maximized`，因为它会与 `--window-size` 冲突——maximized 会覆盖指定尺寸，导致窗口尺寸取决于用户显示器。

---

### Feature 18: `--lang` 语言自动设置

| | |
|---|---|
| **决定** | 采纳（已实现，增加 `--accept-lang` + `fixPreferences`） |
| **里程碑影响** | M1 ✅ |

**功能**：将 `--lang` Chrome 启动参数设为系统 locale（fallback `en-US`），确保 `navigator.language`、`navigator.languages` 和 HTTP `Accept-Language` 头保持一致。

> 来源：[反检测文档 §Feature 18](../../knowledge/browser-use/undetected-chromedriver-anti-detection-guide.md) — `__init__.py:359-369`

**采纳理由**：不显式设置 `--lang` 时，`navigator.language` 和 HTTP `Accept-Language` 头可能不一致，成为检测信号。

反检测文档展示了 undetected-chromedriver 的实现模式（读取系统 locale，fallback `en-US`）：

```python
# __init__.py:359-369
if not language:
    try:
        import locale
        language = locale.getdefaultlocale()[0].replace("_", "-")
    except Exception:
        pass
    if not language:
        language = "en-US"
options.add_argument("--lang=%s" % language)
```

**跨层影响——这是唯一有真正跨层影响的 feature**：

`--lang` 决定了站点返回的界面语言。Twitter 等站点根据 `Accept-Language` 返回对应语言的界面。而 Sites 层的 matchers.ts 中 ARIA `name` 匹配规则是英文的：

```typescript
// matchers.ts 示例（来自设计文档 §matchers.ts）
followButton:  { role: 'button', name: /^Follow$/i },
searchInput:   { role: 'combobox', name: /search/i },
```

如果 `--lang=zh-CN`，Twitter 返回中文界面，按钮 name 变成"关注"而非"Follow"，**匹配失败**。

**结论：`--lang` 必须硬编码 `en-US`**，不跟随系统 locale。这与 undetected-chromedriver 的"跟随系统 locale"策略不同——undetected-chromedriver 不涉及 ARIA 匹配，而 site-use 的 Sites 层依赖英文 ARIA name。

**实现**：三层联动确保语言一致性：

```typescript
// 1. Chrome UI 语言
'--lang=en-US',
// 2. navigator.languages（--lang 不控制此项）
'--accept-lang=en-US,en',
```

```typescript
// 3. fixPreferences() 中强制覆盖 profile 保存的语言设置
// Chrome profile 中 intl.accept_languages 会覆盖 --lang 和 --accept-lang
if (prefs.intl.accept_languages !== 'en-US,en') {
  prefs.intl.accept_languages = 'en-US,en';
}
```

实测发现单独 `--lang=en-US` 不足以控制 `navigator.languages`：Chrome 的持久 profile 中保存的 `intl.accept_languages` 优先级更高，且 `--lang` 只影响 Chrome UI，不影响 `navigator.languages`。需要三管齐下：`--lang`（UI）、`--accept-lang`（HTTP Accept-Language 和 navigator.languages）、`fixPreferences`（覆盖 profile 持久化值）。

---

## 汇总

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
| 11 | `exit_type` 修复 | ✅ 采纳 | M1 ✅ | 扩展为 `fixPreferences` |
| 12 | `--headless=new` 适配 | ❌ 拒绝 | — | 非 headless：不适用 |
| 13 | 进程分离 | ❌ 拒绝 | — | Selenium/ChromeDriver 专属 |
| 14 | `reconnect()` | ❌ 拒绝 | — | Selenium/ChromeDriver 专属 |
| 15 | CDP `tab_new()` | ❌ 拒绝 | — | Puppeteer 已走 CDP |
| 16 | 临时用户目录 | ❌ 拒绝 | — | 设计冲突：需持久 profile |
| 17 | 窗口尺寸 1920×1080 | ✅ 采纳 | M1 ✅ | 标准化 viewport |
| 18 | `--lang` 语言设置 | ✅ 采纳 | M1 ✅ | 三层联动：`--lang` + `--accept-lang` + `fixPreferences` |

### 拒绝分类统计

| 分类 | 涉及 Feature | 数量 |
|------|-------------|------|
| **非 headless：不适用** | 3, 4, 5, 6, 7, 12 | 6 |
| **Selenium/ChromeDriver 专属** | 1, 13, 14 | 3 |
| **Puppeteer 已覆盖** | 15 | 1 |
| **设计冲突** | 16 | 1 |
| **依赖被拒绝的 feature** | 7（依赖 6） | 1 |

### 采纳统计

- **已实现**（7 个）：Feature 2（移除 V1）、8、9（部分）、10、11、17、18
- **拒绝**（11 个）：Feature 1、3、4、5、6、7、12、13、14、15、16

### 诊断验证

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
