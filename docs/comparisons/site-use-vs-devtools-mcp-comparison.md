# site-use vs chrome-devtools-mcp 总体架构对比

> 生成时间：2026-03-18

## 一、定位与目标

| 维度 | site-use | chrome-devtools-mcp |
|------|----------|---------------------|
| **定位** | 站点专用浏览器自动化工具（MVP: Twitter） | 通用浏览器 DevTools 控制 MCP 服务器 |
| **目标用户** | AI Agent（任意 MCP Client） | AI Agent（任意 MCP Client） |
| **核心理念** | 确定性工作流：AI 只管内容理解，不管按钮在哪 | 通用能力暴露：把 DevTools 全部能力交给 AI |
| **抽象层次** | 高层（`twitter_timeline { count: 50 }`） | 低层（`click`、`evaluate`、`take_snapshot`） |
| **站点感知** | 有（matchers.ts / workflows.ts 按站点适配） | 无（站点无关，AI 自行理解页面） |

**核心差异**：site-use 把"找到按钮并点击"这件事封装为确定性代码，AI 只需调用高层命令；devtools-mcp 把浏览器原语暴露给 AI，由 AI 自己通过 snapshot + click 完成操作。

---

## 二、分层架构

### site-use（四层）
```
MCP Client (Claude / OpenClaw Skill / Cursor)
  │ MCP Protocol (stdio)
MCP Server（工具注册 + Mutex 串行化 + 浏览器生命周期）
  ├─ Sites Layer（site-specific）
  │   twitter/matchers.ts / workflows.ts / extractors.ts
  ├─ Primitives Layer（对齐 devtools-mcp 工具语义）
  │   primitives.ts / puppeteer-backend.ts / throttle.ts / auth-guard.ts
  └─ Browser Layer（浏览器生命周期）
      browser.ts
  │ Puppeteer + CDP WebSocket（当前）/ MCP Client（未来可切换）
Chrome（用户本地安装，独立 profile）
```

### chrome-devtools-mcp（三层）
```
MCP Client (Claude / Cursor / 任意 AI)
  │ MCP Protocol (stdio / SSE)
MCP Server（工具注册 + 请求调度）
  │ McpContext → McpPage → Mutex
Context Layer（状态管理、页面生命周期、收集器）
  │ Puppeteer CDPSession
Browser Layer（Chrome + CDP WebSocket）
```

### 差异点
| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **进程模型** | MCP Server 单进程（与 devtools-mcp 一致） | MCP Server 单进程 |
| **通信协议** | MCP (stdio)（与 devtools-mcp 一致） | MCP (stdio / SSE) |
| **有无站点适配层** | 有（sites/twitter/） | 无 |
| **暴露的工具** | 高层业务工具（~8 个） | 低层浏览器原语（35+ 个） |
| **状态持有者** | MCP Server 持有浏览器单例 | MCP Server 持有 McpContext 单例 |

---

## 三、浏览器连接与管理

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **连接方式** | Puppeteer `channel: 'chrome'` 自动发现本地 Chrome | 四种：autoConnect / wsEndpoint / browserURL / launch |
| **Chrome 来源** | 必须用户本地 Chrome（反检测需要） | 支持本地 Chrome / Puppeteer 内置 Chromium / 指定路径 |
| **启动控制** | site-use 拥有启动权（用户不需手动配 Chrome） | 支持连接已有 / 启动新实例 |
| **Profile 策略** | 独立 user-data-dir（登录态持久化） | 可选 user-data-dir / 默认缓存目录 / isolated context |
| **CDP 端口** | 随机端口（非默认 9222，降低扫描风险） | 通过 DevToolsActivePort 自动发现 / 用户指定 |
| **多页面支持** | `Map<site, Page>` 按站点固定映射，自动路由（无通用 page ID 切换） | 多页面（通用 page ID 切换，isolated context） |
| **断连恢复** | 每次命令前检查 `browser.connected`，断开则重启 | 类似，browser.ts 模块级缓存 |

---

## 四、工具 / 命令体系

### site-use：高层业务命令
```bash
site-use twitter check-login        # → {loggedIn: bool}
site-use twitter timeline --count 50 # → Tweet[] + TimelineMeta
site-use twitter follow @handle     # → {success: bool}
site-use twitter user-tweets @handle # → Tweet[]
```
- 命令 = 完整工作流（导航 → 操作 → 提取 → 返回结构化数据）
- 每个命令是原子的，内部封装多步浏览器操作
- AI 不需要理解页面结构

### devtools-mcp：低层浏览器原语（35+ 工具）
```
navigate_page, take_snapshot, click, type, scroll,
evaluate_script, screenshot, network_get_all_requests,
console_get_messages, emulate_device, start_tracing,
lighthouse_audit, ...
```
- 工具 = 单步浏览器操作
- AI 需要：take_snapshot → 理解页面 → 找到元素 uid → click/type
- 7 个分类：Input / Navigation / Emulation / Performance / Network / Debugging / Extensions

### 差异总结
| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **粒度** | 粗粒度（一个命令 = 一个完整场景） | 细粒度（一个工具 = 一步操作） |
| **AI 参与度** | 低（调用命令，分析返回数据） | 高（AI 要理解 snapshot、决策操作序列） |
| **工具数量** | ~8 个 MVP 命令 | 35+ 工具 |
| **返回值** | 业务结构化数据（Tweet[], User[]） | 浏览器原始数据（DOM snapshot, 截图, 网络日志） |
| **可扩展方向** | 新增站点适配器 | 已覆盖 DevTools 全部能力 |

---

## 五、页面理解与元素定位

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **元素定位** | 辅助功能树 snapshot → 语义匹配规则（role + name）→ uid | 辅助功能树 snapshot → AI 理解 → uid |
| **匹配规则维护** | matchers.ts 集中管理，Twitter 改版只改此文件 | 无需规则，AI 从 snapshot 语义理解 |
| **页面理解** | 代码规则匹配（确定性，不需要 AI） | AI 通过 take_snapshot 获取辅助功能树文本表示 |
| **抗改版能力** | 较强（ARIA role/name 比 CSS 类名稳定，但仍可能变化） | 强（AI 语义理解，DOM 结构变不影响识别） |
| **操作确定性** | 强（同样的命令 = 同样的操作路径） | 弱（AI 每次可能走不同路径） |
| **uid 生命周期** | 同 devtools-mcp：snapshot 粒度（每次 takeSnapshot 刷新） | snapshot 粒度（每次 take_snapshot 刷新） |
| **底层机制** | 共享：辅助功能树 + uid 映射 | 辅助功能树 + uid 映射 |

**关键共同点**：两者现在使用**相同的底层机制**（辅助功能树 snapshot + uid），区别仅在于谁来决定"点哪个 uid"——site-use 用代码规则匹配（确定性），devtools-mcp 交给 AI（灵活性）。

**权衡**：site-use 用确定性换取速度和可靠性（规则匹配是毫秒级，且行为可预测），devtools-mcp 用灵活性换取通用性（任何页面都能操作，但 AI 可能犯错且有 token 开销）。

---

## 六、反检测策略

| 层级 | site-use | devtools-mcp |
|------|----------|--------------|
| **浏览器指纹** | `--no-enable-automation` 隐藏 webdriver 标志 | 类似，但源码显示 `navigator.webdriver` 与 `--enable-automation` flag 相关 |
| **Chrome 来源** | 强制用户本地 Chrome | 支持 Puppeteer Chromium（指纹风险更高） |
| **操作节奏** | Puppeteer 内置 DOM 稳定等待（功能正确性）+ throttle.ts 叠加随机延迟 1-3s（反爬） | WaitForHelper 等待 DOM 稳定（100ms+ debounce），无主动随机延迟（通用工具不关心反爬） |
| **频率控制** | 站点级频率上限（Layer 3，MVP 仅检测不恢复） | 无（通用工具层不关心频率） |
| **CDP 端口** | 随机端口 | 标准端口或用户指定 |
| **Profile** | 独立 profile，cookie/localStorage 自然积累 | 可选，支持 isolated context |

**核心差异**：site-use 把反检测作为核心设计目标（三层防御模型），devtools-mcp 是开发/调试工具定位，反检测不是重点。

---

## 七、状态管理

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **浏览器实例** | MCP Server 进程内模块级单例 | MCP Server 进程内模块级单例 |
| **并发控制** | Mutex 串行化 tool call（与 devtools-mcp 一致） | Mutex (FIFO) 串行化工具调用 |
| **页面状态** | 无（每个 tool call 独立操作页面） | McpPage 封装（dialog/snapshot/emulation/collector per page） |
| **网络/控制台收集** | 无（只关心业务数据） | PageCollector 按 navigation epoch 收集，保留最近 3 次 |
| **登录态** | auth-guard 每次 tool call 前检查 | 无（不关心登录态） |
| **生命周期** | 跟随 MCP Client（与 devtools-mcp 一致） | 跟随 MCP Client |

---

## 八、错误处理

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **错误分类** | 业务级：SessionExpired / RateLimited / ElementNotFound | 工具级：包装后返回 `isError: true` |
| **恢复策略** | site-use 不恢复，只检测+分类+抛出；恢复由 Caller（Skill）负责 | 类似，错误返回给 AI Client |
| **内部重试** | Primitives 层对临时性错误重试 2-3 次 | 无明确重试机制 |
| **错误上下文** | 包含 URL、操作步骤、页面状态 | 包含 error cause chain |

---

## 九、通信协议

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **对外协议** | MCP Protocol（stdio）（与 devtools-mcp 一致） | MCP Protocol（stdio / SSE） |
| **内部通信** | 无（单进程，与 devtools-mcp 一致） | 无（单进程） |
| **消息格式** | MCP 标准 tool call（与 devtools-mcp 一致） | MCP 标准 tool call |
| **进度反馈** | MCP progress notification（与 devtools-mcp 一致） | MCP progress notification |
| **输出格式** | MCP TextContent（JSON 业务数据）/ ImageContent（截图） | MCP TextContent / ImageContent |

---

## 十、技术栈对比

| 维度 | site-use | devtools-mcp |
|------|----------|--------------|
| **语言** | TypeScript | TypeScript |
| **运行时** | Node.js | Node.js |
| **浏览器控制** | Puppeteer | Puppeteer |
| **MCP SDK** | @modelcontextprotocol/sdk（与 devtools-mcp 一致） | @modelcontextprotocol/sdk |
| **CLI 解析** | 无需（MCP server，无自定义 CLI） | yargs |
| **测试框架** | Vitest（TBD） | Vitest |
| **DevTools 前端** | 无 | chrome-devtools-frontend（trace 分析、issue 检测） |
| **性能审计** | 无 | Lighthouse 集成 |
| **Schema 验证** | Zod（与 devtools-mcp 一致） | Zod |
| **Telemetry** | 无 | Google Clearcut |

---

## 十一、能力范围对比

| 能力 | site-use | devtools-mcp |
|------|----------|--------------|
| **页面导航** | ✅ 内嵌在工作流中 | ✅ navigate_page |
| **元素交互** | ✅ 内嵌在工作流中 | ✅ click / type / scroll / hover |
| **内容提取** | ✅ 结构化业务数据（Tweet/User） | ⚠️ 原始 snapshot / evaluate_script |
| **截图** | ✅ screenshot tool + 错误时自动截图 | ✅ screenshot |
| **网络监控** | ❌ | ✅ 完整请求/响应追踪 |
| **控制台日志** | ❌ | ✅ console_get_messages |
| **性能分析** | ❌ | ✅ tracing + Lighthouse + CrUX |
| **设备模拟** | ❌ | ✅ viewport / UA / geolocation / network throttling |
| **多页面管理** | ✅ 按站点固定映射（`Map<site, Page>`），无通用 page ID 切换 | ✅（通用 page ID 切换） |
| **扩展管理** | ❌ | ✅ install / uninstall / trigger |
| **登录态管理** | ✅ auth-guard 检测 | ❌ |
| **反检测** | ✅ 三层防御 | ⚠️ 基础（非核心目标） |
| **操作节奏控制** | ✅ throttle.ts | ❌ |

---

## 十二、适用场景对比

| 场景 | site-use 适合度 | devtools-mcp 适合度 |
|------|----------------|---------------------|
| Twitter 定向数据采集 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |
| 任意网站自动化 | ⭐（需新增适配器） | ⭐⭐⭐⭐⭐ |
| Web 应用调试 | ❌ | ⭐⭐⭐⭐⭐ |
| 性能分析 | ❌ | ⭐⭐⭐⭐⭐ |
| 反检测要求高的爬虫 | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| AI Agent 浏览器操作 | ⭐⭐⭐⭐（特定站点） | ⭐⭐⭐⭐⭐（通用） |
| 批量重复操作 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

---

## 十三、可互补之处

1. **两者已共享的模式**（改为 MCP server 后更加对齐）：
   - MCP server 进程模型 + stdio transport
   - Mutex FIFO 锁串行化 tool call
   - browser.ts 模块级单例缓存
   - @modelcontextprotocol/sdk + Zod schema
   - 辅助功能树 snapshot + uid 元素定位

2. **site-use 独有的设计可复用**：
   - 站点适配层抽象（matchers / workflows / extractors 三件套）
   - throttle.ts 操作节奏控制（devtools-mcp 缺少）
   - auth-guard 登录态检测（devtools-mcp 不关心）

3. **潜在集成路径**：
   - site-use 的 Primitives 层可切换为 devtools-mcp client 后端，两个 MCP server 共存但不冲突（site-use 做高层编排，devtools-mcp 做低层执行）
   - site-use 的 matchers 匹配失败时，可降级让 AI 通过 devtools-mcp 的 take_snapshot 自行理解页面

---

## 十四、总结：一句话概括

> **chrome-devtools-mcp 是"给 AI 一个浏览器"，site-use 是"给 AI 一个已经会操作 Twitter 的机器人"。**
>
> 两者现在是**同构架构**（MCP server + Puppeteer + Mutex + 辅助功能树 snapshot），差异仅在暴露的工具粒度。site-use 本质上是一个在 devtools-mcp 之上加了 Sites 适配层的特化版本。
