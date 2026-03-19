# 能力 5：项目工程基础

> 上游文档：[M1 里程碑](../overview.md) — 能力 5
> 状态：已完成（2026-03-19，commit 0842655）

## 目标

建立项目骨架，使得 `npm install && npm run build` 能跑通，`npx site-use` 能启动进程。后续所有能力在此基础上开发。

---

## 产品效果

- 开发者：`git clone && npm install && npm run dev` 开始开发
- 用户：`npx site-use` 启动 MCP server 进程

---

## 依赖项

### 运行时依赖

| 包 | 用途 | 为什么选它 |
|---|------|-----------|
| `@modelcontextprotocol/sdk` | MCP server + stdio transport | MCP 协议的官方 SDK，所有主流 MCP client（Claude Desktop、Cursor、VS Code）天然支持。不自己实现 JSON-RPC |
| `puppeteer-core` | 浏览器控制（通过 CDP） | 用 `-core` 而非完整 `puppeteer`，因为 site-use 通过 `channel: 'chrome'` 使用用户本地 Chrome，不需要捆绑 ~170MB 的 Chromium。Node.js 生态下 CDP 控制的事实标准。devtools-mcp 同样用 Puppeteer，保持同构便于参考代码。不选 Playwright 是因为 Primitives 层的设计围绕 CDP 原生 API（Accessibility.getFullAXTree），Playwright 封装了一层自己的 accessibility API，反而增加了对齐 devtools-mcp 的难度 |
| `zod` | MCP 工具参数 schema 定义 | `@modelcontextprotocol/sdk` 的 `server.tool()` 原生用 Zod 定义参数 schema，不是自选的依赖，是 SDK 要求的 |

### 开发依赖

| 包 | 用途 | 为什么选它 |
|---|------|-----------|
| `typescript` | 编译 | 架构设计文档已确定用 TypeScript（与 devtools-mcp 同语言，Puppeteer 原生 TS 支持） |
| `@types/node` | Node.js 类型 | TypeScript 标配 |
| `vitest` | 测试框架 | 与 ESM 项目零配置兼容，比 Jest 对 ESM 的支持更好。`vi.stubEnv()` 内置支持环境变量 mock，适合测 config.ts |

---

## 目录结构

```
site-use/
├── package.json
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.ts                        # bin 入口：启动 MCP server
│   ├── server.ts                       # MCP server 主体
│   ├── errors.ts                       # 错误类型
│   ├── config.ts                       # 配置（数据目录、代理、环境变量）
│   ├── browser/
│   │   └── browser.ts                  # Chrome 生命周期
│   ├── primitives/
│   │   ├── types.ts                    # Primitives 接口（全部 8 个原语）
│   │   ├── puppeteer-backend.ts        # Puppeteer 实现（M1：6 个）
│   │   └── throttle.ts                 # 节流包装
│   └── sites/
│       └── twitter/
│           ├── matchers.ts             # ARIA 匹配规则
│           ├── workflows.ts            # checkLogin + getTimeline
│           ├── extractors.ts           # 内容提取
│           └── types.ts                # Tweet, TweetAuthor, TimelineMeta
└── tests/
    ├── unit/                           # 单元测试
    └── integration/
        └── README.md                   # 手动集成测试指南
```

**原则**：M1 不创建空目录或占位文件，只创建当前需要的文件。目录结构为未来预留位置（`sites/reddit/`、`primitives/devtools-mcp-backend.ts`、`fingerprint/`），但不提前创建。

### 为什么按架构层组织而非按功能组织

项目目录按 `browser/` → `primitives/` → `sites/` 分层，而不是按功能聚合（如 `twitter/` 下包含 browser + primitives + workflows）。原因：

1. **层间依赖是单向的**：sites 调 primitives，primitives 调 browser，反过来不行。目录结构反映了这种依赖关系
2. **primitives 和 browser 是跨站点共享的**：未来加 reddit 站点时，用的是同一套 Primitives 和 Browser，不应该放在 twitter 目录下
3. **与架构设计文档的分层图一致**：读文档的人能直接在代码里找到对应的层

---

## 关键配置

### package.json

- `"type": "module"` — 使用 ESM。`@modelcontextprotocol/sdk` 和 Puppeteer 都是 ESM 优先的包，用 CJS 需要额外 hack
- `"bin": { "site-use": "dist/index.js" }` — npm bin 入口，使 `npx site-use` 直接可用
- scripts：`build`（tsc）、`dev`（tsc --watch）、`test`（vitest run）、`test:watch`（vitest）

### tsconfig.json

- `target: ES2022` — 使用 top-level await、Promise.allSettled 等现代语法，Node 18+ 均支持
- `module: Node16`、`moduleResolution: Node16` — ESM 项目的推荐配置，正确处理 `.js` 扩展名和 `package.json` 的 `exports` 字段
- `outDir: dist`、`rootDir: src`
- `strict: true`

### .gitignore

需要忽略的内容：
- `node_modules/`、`dist/` — 标准
- `chrome-profile/` — Chrome 用户数据（含 cookies、登录态）
- `*.db` — M4 的 SQLite 指纹数据库
- `.site-use/` — 本地数据目录

---

## 对未来的支持

| 决策 | 为什么不会返工 |
|------|--------------|
| ESM (`"type": "module"`) | MCP SDK 和 Puppeteer 都支持 ESM，未来不需要改 |
| `dist/` 输出目录 | 所有后续代码编译到同一位置 |
| 目录结构按架构层组织 | M2 加文件不改结构；M4 加 `fingerprint/` 目录 |
