# site-use 包架构设计

> 更新时间：2026-03-24
> 状态：构想阶段

## 概述

site-use 的对外分发架构，定义 npm 包组织、CLI 命令体验、MCP 工具接口和插件机制。

与 [site-use-design.md](site-use-design.md) 互补——后者定义内部技术分层，本文定义对外的包边界和用户体验。

---

## 四层架构

```
分发层 (Adapters)              怎么接入
├── @site-use/mcp             MCP server（Claude Desktop / Cursor）
├── @site-use/claude-ext      Claude Code extension
├── @site-use/openclaw        OpenClaw skill plugin
└── @site-use/api             REST API（给非 MCP 客户端）

站点层 (Sites)                 站点适配，按区域分组
├── @site-use/sites-social    Twitter, Reddit, LinkedIn
├── @site-use/sites-cn        小红书, 微博, B站
└── @site-use/sites-media     YouTube, TikTok

核心层 (Core)                  抽象、框架、通用能力
└── @site-use/core
    ├── primitives 接口定义
    ├── plugin loader
    ├── 配置管理
    ├── CLI 框架
    └── 通用能力（内置，不单独拆包）
        ├── form     表单识别与填写
        ├── auth     登录态、cookie、QR code、2FA
        ├── capture  截图、PDF、内容存档
        ├── table    表格数据提取、分页采集
        ├── stealth  反检测（指纹、行为模拟）
        └── proxy    代理管理、IP 轮换

引擎层 (Engine)                浏览器驱动
├── @site-use/puppeteer       Puppeteer 实现
├── @site-use/playwright      Playwright 实现（多浏览器）
└── @site-use/cdp             直接 CDP（最轻量）
```

### 为什么通用能力合入 core

form、auth、capture 等通用能力几乎每个站点都要用，不是可选的。单独拆包只增加安装复杂度，没有真正的解耦收益。

### 为什么站点按区域分组

- 同区域站点共享模式（如国内站点都要扫码登录、类似反爬策略）
- 减少包数量，降低用户心智负担
- 单站点代码量不大，不值得独立发包

### 全家桶包

提供一个无 scope 的 `site-use` 全家桶包，聚合常用组合：

```jsonc
{
  "name": "site-use",
  "dependencies": {
    "@site-use/core": "^x",
    "@site-use/puppeteer": "^x",
    "@site-use/sites-social": "^x",
    "@site-use/mcp": "^x"
  }
}
```

## 依赖规则

依赖只能向下，不能向上，不能跨层平级依赖（站点层之间除外）。

```
分发层 → 站点层 → 核心层 → 引擎层
           ↕
     （站点层之间可依赖）
```

---

## 能力层与分发层解耦

站点包只导出纯逻辑，不感知自己运行在什么环境中：

```ts
// @site-use/sites-social 中的 twitter 模块
export const twitter = {
  name: "twitter",
  type: "site",
  actions: {
    feed:   { params: z.object({...}), execute: async (ctx) => {...} },
    follow: { params: z.object({...}), execute: async (ctx) => {...} },
  }
}
```

分发层做薄适配：

```ts
// MCP adapter:    → server.tool("site_read", ...) 内部路由到 twitter.actions.feed
// Claude ext:     → registerCommand("site-use.twitter-feed", ...)
// OpenClaw:       → defineSkill({ name: "twitter-feed", ... })
```

**能力包永远不 import 任何分发层的依赖**（不 import MCP SDK、不 import OpenClaw SDK）。

## 引擎层抽象

core 定义浏览器引擎接口，各引擎包提供实现：

```ts
// @site-use/core 定义接口
interface BrowserEngine {
  goto(url: string): Promise<void>
  click(selector: string): Promise<void>
  type(selector: string, text: string): Promise<void>
  screenshot(): Promise<Buffer>
  evaluate<T>(fn: () => T): Promise<T>
}

// @site-use/puppeteer 实现接口
// @site-use/playwright 实现接口
```

能力包调用 core 的抽象接口，永远不直接 import puppeteer 或 playwright。

## 插件发现机制

core 启动时自动扫描已安装的 `@site-use/*` 包：

```ts
// 每个包导出标准接口
export default {
  type: "site" | "engine" | "adapter",
  name: "twitter",
  actions: {...},
  register(ctx) {}
}
```

用户按需安装，core 自动加载，不需要手动配置。

---

## MCP 工具设计

### 设计原则

每个 MCP tool 的 schema 会占用 Agent 的上下文窗口。如果按站点×操作注册工具（twitter_feed, twitter_follow, reddit_search ...），工具数量会随站点增长而爆炸，撑爆 Agent 上下文。

site-use 采用**语义动词**模式：少量固定工具 + 参数路由，而非大量窄工具。

### 工具列表

| 工具 | 用途 | 示例 |
|------|------|------|
| `site_read` | 读取内容（feed、search、profile、thread） | `site_read({ site: "twitter", what: "feed", count: 20 })` |
| `site_act` | 执行操作（follow、like、post、form fill） | `site_act({ site: "twitter", what: "follow", target: "@elonmusk" })` |
| `site_auth` | 登录态管理（检查、登录引导、cookie） | `site_auth({ site: "twitter", action: "check" })` |
| `site_list` | 列出可用站点和 action | `site_list()` |

4 个工具覆盖所有场景。Agent 通过参数区分具体行为。

### 为什么不暴露 browser 管理工具

MCP 场景下，浏览器生命周期由 server 内部管理——Agent 调 `site_read` 时 server 自动启动/连接 Chrome。Agent 不需要操心浏览器。浏览器管理只在 CLI 场景下暴露为子命令。

### 与底层原语的区别

site-use 不是 devtools-mcp。底层的 navigate/click/extract 组合让 Agent 重新面对 DOM 结构，违背了 site-use 的核心价值——**让 AI 专注于内容理解，不操心页面操作**。

site-use 的"组合"发生在**语义层**，不是 DOM 层：

```
❌ navigate twitter.com | extract "[data-testid='tweet']"  （Agent 要懂 DOM）
✅ site_read({ site: "twitter", what: "feed" })             （Agent 只关心内容）
```

---

## CLI 命令设计

### 命令结构

```
site-use                              → 默认启动 MCP server
site-use <site> <action> [args]       → 站点操作
site-use <skill> <action> [args]      → 通用能力
site-use <reserved> <action>          → 内置命令
```

核心理念：**包名即命令名**，`@site-use/sites-social` 装了就有 `site-use twitter`、`site-use reddit`。

### 保留关键字（一级子命令）

以下为 core 自带的保留字，发布新站点包时必须避开：

| 关键字 | 用途 |
|--------|------|
| `serve` | 启动 MCP server |
| `browser` | 浏览器生命周期管理（仅 CLI） |
| `config` | 配置管理 |

### 使用示例

```bash
# MCP server
site-use                                # 默认启动 MCP server
site-use serve                          # 同上，显式指定
site-use serve --engine playwright      # 指定浏览器引擎

# 站点操作
site-use twitter feed
site-use twitter follow @elonmusk
site-use reddit search "MCP"
site-use xhs explore

# 通用能力
site-use form fill https://example.com/apply --data ./info.json
site-use capture screenshot https://example.com -o page.png

# 浏览器管理（仅 CLI，MCP 下由 server 自动管理）
site-use browser launch
site-use browser connect 9222
site-use browser status
site-use browser close
```

---

## MCP Server 配置

```jsonc
// Claude Desktop / Cursor
{
  "mcpServers": {
    "site-use": {
      "command": "npx",
      "args": ["site-use", "serve"]
    }
  }
}
```

## SDK 编程调用

```ts
import { createBrowser } from "@site-use/core"
import { twitter } from "@site-use/sites-social"

const browser = await createBrowser()
const feed = await twitter.actions.feed.execute({ browser, count: 20 })
```

---

## 用户安装场景

```bash
# 最常见：全家桶一步到位
npm install -g site-use

# 轻量：只要社交平台
npm install -g @site-use/core @site-use/puppeteer @site-use/sites-social

# 换引擎
npm install -g @site-use/playwright    # 替换 puppeteer

# 只用通用能力（不针对特定站点）
npm install -g @site-use/core @site-use/puppeteer
# core 自带 form、capture 等通用能力
```

---

## 落地节奏

| 阶段 | 做什么 |
|------|--------|
| **当前** | 保持单包 `site-use`，内部按 sites/skills 目录组织 |
| **拆包时机** | 第二个站点加入时（reddit 或 xhs），拆成 pnpm workspace monorepo |
| **工具** | pnpm workspace + changeset 管理多包发布 |
| **npm 占位** | 尽早注册 `@site-use` org 和 `site-use` 包名 |

现阶段不需要拆包——内部目录边界守好，将来拆包只是移目录 + 加 package.json，代码不用大改。
