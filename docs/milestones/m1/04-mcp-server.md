# 能力 3：MCP Server 骨架

> 上游文档：[技术架构设计](../../site-use-design.md) — MCP Server 章节，[M1 里程碑](../overview.md) — 能力 3
> 状态：已完成（2026-03-22）

## 目标

用户在 Claude Desktop / Cursor 的 MCP 配置里加一行 `"command": "npx site-use"`，就能开始使用。MCP Server 负责工具注册、生命周期管理、并发控制。

---

## 文件

| 文件 | 职责 |
|------|------|
| `src/server.ts` | MCP server 主体：工具注册、Mutex、Primitives 单例管理、错误格式化 |
| `src/index.ts` | bin 入口：import server，调用 `main()` |

---

## 用户配置

```json
{
  "mcpServers": {
    "site-use": {
      "command": "npx",
      "args": ["site-use"]
    }
  }
}
```

---

## M1 暴露的 MCP 工具（3 个）

| 工具 | 对应 workflow | 输入参数 | 返回 |
|------|-------------|---------|------|
| `twitter_check_login` | `checkLogin()` | 无 | `{ loggedIn: boolean }` |
| `twitter_timeline` | `getTimeline(count)` | `{ count?: number }` (默认 50) | `{ tweets: Tweet[], meta: TimelineMeta }` |
| `screenshot` | Primitives `screenshot()` | `{ site?: string }` (默认最近使用的页面) | base64 PNG 图片 |

### 工具注册方式

使用 `@modelcontextprotocol/sdk` 的 `McpServer.tool()` 方法，参数用 Zod schema 定义：

```typescript
server.tool(
  'tool_name',
  'tool description',
  { param: z.string().optional() },  // Zod schema
  async (params) => { /* handler */ }
);
```

M2 用同样的模式注册更多 tool，注册机制不需要修改。

---

## 设计理由

### 为什么 site-use 是 MCP server 而不是 CLI 工具或 HTTP 服务

1. **与 AI agent 的天然集成**：MCP 是 Claude、Cursor 等 AI 产品的标准扩展协议。做成 MCP server，用户在 AI 对话中说"帮我看 Twitter"，agent 直接调 tool，不需要用户手动跑命令
2. **进程生命周期由 MCP client 管理**：MCP client 负责启动和停止 server 进程，用户不需要手动管理后台服务
3. **与 devtools-mcp 同构**：site-use 和 devtools-mcp 是同类东西——都是持有浏览器连接的 MCP server，差别只在暴露的工具粒度（高层业务工具 vs 低层浏览器原语）

### 为什么用 stdio transport 而不是 HTTP/SSE

stdio 是 MCP 协议最基本的传输方式，所有 MCP client 都支持。HTTP/SSE transport 适合远程访问场景，但 site-use 本来就在用户本地运行（操控本地 Chrome），不需要网络传输。stdio 更简单，不需要处理端口分配、CORS、认证等 HTTP 问题。

---

## 核心机制

### Mutex 串行化

所有 tool call 通过 Mutex 串行化执行，与 devtools-mcp 一致。

**为什么不并行执行 tool call**：浏览器是有状态的——当前 URL、DOM 状态、辅助功能树快照都是全局的。如果两个 workflow 同时操作同一个 page（一个在滚动采集，另一个在点击按钮），它们会互相干扰。Mutex 串行化是最简单的正确性保证。devtools-mcp 也用同样的策略。

- FIFO 队列：先到先执行，保证公平性
- 同一时刻只有一个 tool 操作浏览器
- 保证浏览器状态一致性（不会两个 workflow 同时操作同一个 page）

```
tool call 到达 → mutex.acquire() → 获得锁
    → 执行 handler
    → mutex.release() → 唤醒队列中下一个
```

### Lazy Chrome

浏览器不在 server 启动时创建，而是第一个需要浏览器的 tool call 触发。

**为什么 lazy 而不是 server 启动时就打开 Chrome**：MCP client（如 Claude Desktop）在启动时会启动所有配置的 MCP server。如果 site-use 启动就打开 Chrome，用户每次打开 Claude Desktop 都会弹出一个 Chrome 窗口，即使这次对话完全不涉及 Twitter。Lazy 启动意味着只有用户说"帮我看 Twitter"时才弹窗。

```
MCP Server 启动（stdio transport 就绪）
    → 等待 tool call
    → 第一个 tool call 到达
    → ensureBrowser() 启动 Chrome
    → 创建 PuppeteerBackend + ThrottledPrimitives
    → 执行 workflow
```

### Primitives 单例

```
primitivesInstance: Primitives | null

getPrimitives():
    ├─ 实例存在且浏览器连接中 → 返回现有实例
    └─ 否则 → ensureBrowser() → 新建 PuppeteerBackend → 包装 ThrottledPrimitives
```

### 断线恢复

每次 `getPrimitives()` 检查 `isBrowserConnected()`：
- 连接正常 → 复用
- 断线 → 清空 primitives 单例 → 重新 `ensureBrowser()` → 新建实例

对 MCP client 透明——下一次 tool call 自动重连。

---

## 浏览器状态机

```
         MCP Client 连接
              │
              ▼
┌─────────────────────────┐
│    无浏览器（IDLE）       │ ←── Chrome 被用户关闭 / 崩溃
└────────────┬────────────┘
             │ 收到第一个 tool call
             │ → ensureBrowser() 启动 Chrome
             │ → 创建 Primitives
             ▼
┌─────────────────────────┐
│    已连接（ACTIVE）       │ ←── 正常服务
│                         │     执行 workflow，返回结果
└────────────┬────────────┘
             │ MCP Client 断开连接
             ▼
┌─────────────────────────┐
│    Server 退出            │
│    （不关闭 Chrome）       │
└─────────────────────────┘
```

---

## 错误输出协议

所有 tool 返回 MCP 标准的 content 数组。

**成功**：

```json
{
  "content": [{ "type": "text", "text": "{\"loggedIn\":true}" }]
}
```

**失败**（`isError: true`）：

```json
{
  "content": [{ "type": "text", "text": "{\"type\":\"SessionExpired\",\"message\":\"...\",\"context\":{\"url\":\"...\"}}" }],
  "isError": true
}
```

**截图**（使用 ImageContent）：

```json
{
  "content": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }]
}
```

### 为什么错误也返回 JSON（而不是纯文本 error message）

MCP 协议的 `isError: true` 只表示"这次调用失败了"，但 MCP client（AI agent）需要知道**为什么**失败才能做正确的下一步决策。如果只返回 `"Twitter session expired"`，agent 需要用 NLP 解析 error message。返回结构化 JSON（`{ type: "SessionExpired", context: { url: "..." } }`），agent 可以直接基于 `type` 字段做分支：`SessionExpired` → 提示用户登录；`ElementNotFound` → 调 `screenshot` 看页面状态；`BrowserDisconnected` → 直接重试。

### 错误格式化

`formatToolError()` 函数将内部错误类型转为 MCP 标准输出：

| 内部错误 | MCP 输出中的 type 字段 |
|---------|---------------------|
| `ElementNotFound` | `"ElementNotFound"` |
| `SessionExpired` | `"SessionExpired"` |
| `BrowserDisconnected` | `"BrowserDisconnected"`（同时清空 primitives 单例触发重连） |
| 其他 | `"InternalError"` |

M3 增加 `RateLimited`、`NavigationFailed` 类型，协议格式不变。

---

## 代理认证处理

代理的 `--proxy-server` 参数在 browser.ts 中注入（浏览器级别）。但代理认证（用户名/密码）是 page 级别操作（Puppeteer 的 `page.authenticate()`）。

处理位置：`getPrimitives()` 创建完 backend 后，如果配置了代理认证，通过 escape hatch 拿到 twitter page 调用 `page.authenticate()`。

**为什么认证逻辑在 server.ts 而不是 browser.ts 或 workflow 里**：browser.ts 只管 Chrome 进程生命周期，不知道 page 的概念；workflow 不应该关心基础设施细节。server.ts 作为"组装层"（把 browser、backend、throttle、config 串起来的地方），是处理这种跨层配置的正确位置。

---

## 测试策略

- server.ts 整体需要 MCP client 连接才能测试，属于集成测试
- Mutex 可以单独单元测试（纯逻辑）
- 手动测试方式：`npx @modelcontextprotocol/inspector node dist/index.js`

---

## 对未来的支持

| 决策 | 为什么不会返工 |
|------|--------------|
| 工具注册模式（`server.tool()`） | M2 用同样模式注册更多 tool |
| Mutex 串行化 | 全局保证，未来站点也经过同一个 Mutex |
| Lazy Chrome + 断线恢复 | 基础设施，M1 后不需要改 |
| 错误输出协议（JSON + isError） | M3 丰富错误类型但协议不变 |
