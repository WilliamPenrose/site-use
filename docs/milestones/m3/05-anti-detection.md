# 能力 05：反检测增强

> 上游：[M3 概览](00-overview.md) — Group B
> 状态：实现前需完成调研

## 定位

Group B — 每项能力在实现前需先完成调研（research spike）。本文档定义调研范围和验收标准，调研结论出来后再补充实现细节。

---

## 候选能力

| # | 能力 | 目的 | 调研问题 |
|---|------|------|---------|
| B1 | Canvas 指纹噪声 | 防止跨站关联追踪 | Twitter 是否做 Canvas 指纹？噪声注入是否反而触发检测？ |
| B2 | WebRTC 泄漏防护 | 使用代理时防止真实 IP 泄漏 | 当前配置下 WebRTC 是否真的会泄漏 IP？Chrome 启动参数能否直接禁用？ |
| B3 | 广告/追踪器域名屏蔽 | 减少噪声 DOM + 加速页面加载 | 屏蔽是否会破坏 Twitter 功能？是否可能触发反爬检测？ |
| B4 | 限流信号检测 | 检测 429 / 验证码页面 → 抛出 `RateLimited` | Twitter 限流的具体表现形式？HTTP 429？页面内容变化？重定向？ |

---

## 调研方法

每项遵循三步调研流程：

1. **桌面调研** — 搜索现有文献、开源项目经验、浏览器自动化社区知识
2. **实际验证** — 在 site-use 的 Chrome 配置下观察实际行为
3. **结论** — 实现 / 跳过 / 延后，附理由

---

## 验收标准

| 结论 | 条件 |
|------|------|
| **实现** | 风险确实存在 + 实现简单 + 不破坏正常功能 |
| **跳过** | 在 Twitter 场景下风险不存在，或实现可能引入新问题 |
| **延后** | 风险存在但当前优先级低；记录到概览的待解决问题中 |

---

## 已知上下文

来自 [03-rate-limiting.md](03-rate-limiting.md) 和[里程碑概览](../overview.md)的调研：

- Twitter **不使用 Cloudflare**（概览中已确认）— 无需处理 Cloudflare challenge
- Twitter 限流可能表现为 HTTP 429 或页面内验证码 — 需实际验证
- WebRTC 泄漏大概率可通过 Chrome 启动参数（`--disable-webrtc` 或 `--force-webrtc-ip-handling-policy`）解决，无需复杂的页面注入
- Canvas 噪声是双刃剑 — 部分检测系统专门检查不一致的 Canvas 输出作为机器人信号

---

## 对 Group A 的依赖

- **B4**（限流信号检测）依赖 [04-error-handling.md](04-error-handling.md) 中定义的 `RateLimited` 错误类型 — 在 Group A 完成后再实现
- **B1、B2、B3** 无 Group A 依赖 — 可独立推进

---

## 实现方式

每项能力独立：
- 调研通过 → 补充实现设计并推进
- 调研不通过 → 记录结论，标记为"跳过"或"延后"

无需等所有调研完成 — 任何通过调研的项目都可以立即实现。

---

## 验证

验证标准在调研结束后按项定义，因为具体标准取决于选择的实现方案。

---

## 调研日志

> 随调研完成逐步更新。

### B1: Canvas 指纹噪声
- 状态：**跳过** — 简单噪声注入在 2025+ 已适得其反
- 调研日期：2026-03-22

**Canvas 指纹的本质：** 它不是"检测机器人"的手段，而是**设备标识**手段。网站在页面中创建不可见的 `<canvas>` 元素，绘制特定内容（文字、渐变、几何图形），然后通过 `toDataURL()` / `getImageData()` 提取像素数据取哈希。由于同样的绘图指令在不同硬件（GPU、驱动）和软件（OS、字体渲染引擎）下会产生像素级差异，这个哈希就成了设备的"隐性唯一标识符"——用户清了 cookie、换了 IP，但 canvas 哈希没变，网站仍然知道是同一台设备。

**网站用 canvas 指纹做什么：**

1. **跨会话追踪** — cookie 可删、IP 可换，但 canvas 哈希取决于硬件和驱动，用户几乎无法控制。广告网络和分析平台用它做跨站用户关联。
2. **多账号检测** — 同一台设备登录多个"不同用户" → canvas 哈希相同 → 平台判定多账号。电商、社交平台、博彩网站的核心反作弊手段。
3. **欺诈评分的一个维度** — canvas 不单独决策，而是与 WebGL renderer、User-Agent、屏幕分辨率、字体列表、AudioContext 等几十个信号组合喂给风控模型。这些维度之间必须**自洽**，矛盾即加分。
4. **检测篡改行为** — 网站不只读哈希，还验证 canvas API 完整性：同页面多次调用对比（正常设备结果相同）、已知颜色像素精确验证、API 原型链检查、执行时间检测。

> 注：Canvas 指纹在 GDPR 下被视为未经同意采集个人数据，但实际执法很少针对，大量网站仍在使用。

**结论：跳过。** 不实现 canvas 噪声注入。行业共识（2024-2025）是：朴素的噪声注入已经从"隐私保护手段"变成了**检测信号**。

**噪声注入为何适得其反：**

1. **唯一性悖论** — 随机噪声产生的哈希全球唯一，不匹配检测数据库（FingerprintJS、Castle.io）中任何已知真实设备。"太独特"比融入群体更可疑。
2. **不稳定 = 信号** — 真实用户的 canvas 哈希在同一设备上跨会话稳定。每次刷新都变本身就是明显的机器人指标。
3. **跨维度不一致** — 噪声破坏了 canvas 隐含硬件与 WebGL renderer / User-Agent / 屏幕分辨率之间的一致性。CreepJS 将此标记为"谎言"并降低信任分数。
4. **Hook 可被检测** — 原型链检查（`toDataURL.toString()`）、error stack trace 泄漏、执行时间异常都能暴露注入行为。
5. **工具签名** — 不同噪声工具产生不同的统计偏差模式，形成工具级别的指纹（deviceandbrowserinfo.com 有文档记录）。

**反检测浏览器厂商的替代做法：**

- **Multilogin**（行业标杆）：模拟完整的真实设备配置，所有指纹维度自洽 — 不用随机噪声。
- **Kameleo** "智能 Canvas 欺骗"：将 canvas 输出映射到**已知的、非唯一的**真实设备哈希，而非随机噪声。其团队分析了来自 100 万+ 网站的数千个 canvas 图像。
- **Apify `fingerprint-suite`**（开源，增长迅猛）：使用贝叶斯生成网络（基于真实浏览器流量数据训练）生成统计上逼真的指纹组合。专为 Puppeteer/Playwright 设计。GitHub: `apify/fingerprint-suite`。**如果未来需要修改 canvas，这是推荐方案。**

**我们的策略：** 不干预。site-use 连接真实 Chrome 实例，使用真实硬件渲染。canvas 哈希天然融入同硬件配置的用户群体中，比任何注入都安全。

**如果后续重新评估：** 采用 Apify `fingerprint-suite` 的方式（一致的、逼真的指纹生成）而非随机噪声。在现代检测体系中，行为信号（鼠标轨迹、滚动模式、打字节奏）比指纹伪造更重要 — 我们已经通过 ghost-cursor 集成在处理这方面。

### B2: WebRTC 泄漏防护
- 状态：**已实现**
- 调研日期：2026-03-22

**WebRTC 泄漏的本质：** WebRTC 是浏览器的实时通信协议（视频通话、屏幕共享），需要知道双方的真实 IP 才能建立点对点连接。它通过 STUN 服务器发现公网 IP，走 UDP 协议**绕过 HTTP 代理和 VPN 隧道**。网站只需几行 JS（创建 `RTCPeerConnection` + 监听 `onicecandidate`）就能拿到真实 IP。

**网站用 WebRTC 泄漏做什么：**

1. **代理/VPN 检测** — 核心用途。比较 HTTP 请求 IP 与 WebRTC 获取的 IP，不一致 → 用户在用代理/VPN → 风控加分。
2. **多账号关联** — 多个"不同用户"的 WebRTC IP 相同 → 同一人。
3. **地理位置验证** — WebRTC IP 的地理定位与声称位置不符 → 欺诈信号。
4. **设备指纹补充维度** — 媒体设备枚举、SDP 字符串中的编解码器支持、WebRTC 特性布尔值等也构成指纹。

**实际验证（2026-03-22）：**

环境：Clash System Proxy 模式（仅代理 HTTP/HTTPS，不代理 UDP），Chrome 146。

- 诊断页面最初未检测到泄漏（检查代码只过滤了 IPv4）
- BrowserLeaks 验证：WebRTC 通过 STUN 暴露了真实 **IPv6** 地址（`2408:8207:...`），与 HTTP 代理 IP（`172.104.42.114`）不一致，红色警告
- 修复检查代码后，诊断页面成功检测到 IPv6 泄漏

**关键发现：** Clash System Proxy 模式只代理 HTTP/HTTPS，UDP 流量（包括 STUN 请求）直连，导致 WebRTC 泄漏真实 IPv6 地址。这在使用代理的场景下是一个真实的安全风险。

**修复方案：** 通过 Chrome Profile Preferences 设置 `webrtc.ip_handling_policy`，不需要任何页面注入或 API hook。

> **踩坑记录：** 最初尝试 Chrome 命令行参数 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`，启动参数中已确认存在，但实测无效——BrowserLeaks 仍然检测到 IPv6 泄漏。该参数可能仅在 Chrome Enterprise Policy 层面生效，普通命令行方式不可靠。改用 Preferences 文件写入 `webrtc.ip_handling_policy` 后，BrowserLeaks 确认 **No Leak**，且 `RTCPeerConnection` API 仍然可用（不会被 CreepJS 标记为篡改）。

**实现方式：** 在 `browser.ts` 的 `fixPreferences()` 中写入 Chrome Profile Preferences：

```json
{ "webrtc": { "ip_handling_policy": "disable_non_proxied_udp" } }
```

通过环境变量 `SITE_USE_WEBRTC_POLICY` 配置，三个可选值：

| 值 | 效果 | 适用场景 |
|---|------|---------|
| `disable_non_proxied_udp`（**默认**） | 禁止所有不走代理的 UDP，STUN 请求被阻断 | 日常自动化，防泄漏 |
| `default_public_interface_only` | 只允许默认公网接口 UDP，Spaces 可用但 STUN 仍可能暴露 IP | 需要 Twitter Spaces 音视频 |
| `off` | 删除该 Preferences 字段，完全放开 | 完全不限制 |

**为什么不用其他方案：**

- `--force-webrtc-ip-handling-policy` 命令行参数 → 实测无效（见踩坑记录）
- `RTCPeerConnection = undefined`（删除 API）→ CreepJS 可检测 API 被删除，标记为篡改
- `--disable-webrtc` → Chrome 不支持此参数
- 浏览器扩展 → headless 模式不支持

**副作用：** 默认策略下 Twitter Spaces 音视频不可用。Twitter 浏览、发推、互动、DM 等核心功能完全不受影响。需要 Spaces 时可通过环境变量切换策略。

### B3: 广告/追踪器域名屏蔽
- 状态：**跳过** — Twitter 场景下广告不影响操作；未来扩站时再评估
- 调研日期：2026-03-22

**广告拦截的目的：** 屏蔽广告/追踪器网络请求，减少噪声 DOM、加速页面加载、避免广告遮挡点击目标。

**Twitter 场景评估：** 广告量少且不遮挡正文、导航、交互元素。自动化通过 CSS selector 定位目标，广告不影响 DOM 元素的可交互性。加速页面加载不是当前目标。

**结论：跳过。** 对 Twitter 场景价值极低。

**调研记录（供未来扩站参考）：**

如果未来需要支持广告密集站点（下载站假按钮、全屏遮罩广告、cookie consent 弹窗等），推荐方案：

1. **首选：`@ghostery/adblocker-puppeteer`** — 纯 TypeScript，3 行代码集成，支持 EasyList / uBlock Origin 99% 规则，自动更新过滤列表，不禁用浏览器缓存。实测 CNN.com 加载快 25 秒、流量少 35%。
2. **轻量备选：CDP `Network.setBlockedURLs`** — 原生 CDP，按域名屏蔽，无需第三方库，但规则粗糙。
3. **不推荐：`setRequestInterception`** — 会禁用浏览器缓存，Apify 明确反对。
4. **不推荐：浏览器扩展（uBlock Origin 等）** — headless 模式不支持，MV3 迁移带来兼容问题。

**反检测注意事项：**
- 广告拦截本身通常不触发机器人检测（30%+ 真实用户使用广告拦截器）
- 但拦截器的具体配置可作为指纹信号（Fingerprint.com 有研究）
- 网站可检测广告元素缺失并弹出反广告拦截弹窗，形成新的遮挡问题

### B4: 限流信号检测
- 状态：**已实现**
- 调研日期：2026-03-22

**限流检测的本质：** 自动化浏览器在高频操作时可能触发网站的限流机制。不同网站限流表现不同——Twitter 返回 HTTP 429 + error code 88，其他网站可能弹验证码或返回空数据。需要一个通用框架来检测并响应这些信号。

**调研结论（2026-03-22）：**

- Twitter 限流表现：HTTP 429 + `x-rate-limit-reset` 头 + JSON body 中 error code 88
- 429 + `x-rate-limit-remaining > 0` 表示账号封禁（不是普通限流）
- 无渐进降级——直接从正常切到 429
- CAPTCHA (Arkose FunCaptcha) 仅在注册/登录时触发，浏览限流不会弹验证码

**实现方式：** 两个独立机制，嵌入现有层，不新增 Primitives 包装层：

1. **响应级检测（`RateLimitDetector`）：** 在 `PuppeteerBackend` 创建页面时安装 `page.on('response')` 监听器。每个站点可提供自定义 `DetectFn`，未配置的站点自动使用默认 HTTP 429 检测。信号按站点隔离——Twitter 429 不会阻塞其他站点的操作。

2. **熔断器（Circuit Breaker）：** 在 MCP Server 的 `formatToolError` 中维护连续错误计数器。连续 5 次操作失败时触发，抛出 `RateLimited` 并保留最后一个错误的类型和消息。`BrowserDisconnected` 和 `RateLimited` 不计入失败次数。这是终极兜底——即使站点改变限流表现形式（绕过已知信号检测），连续失败也会触发熔断。

**Twitter 专用检测（`twitterDetect`）：**

| 信号 | 含义 |
|------|------|
| HTTP 429 + remaining=0 | 普通限流，等 reset 时间 |
| HTTP 429 + remaining>0 | 账号被封禁 |
| HTTP 200 + body error code 88 | 限流（非标准状态码） |

**扩展方式：** 新站点只需提供 `DetectFn`，注册到 `RateLimitDetector` 即可。未注册的站点自动走默认 429 检测。

**副作用：** 无。检测器是纯粹的响应观察者，不修改请求或页面行为。
