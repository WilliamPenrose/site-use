# 项目工程基础 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 搭建项目骨架，使 `pnpm install && pnpm run build` 能跑通，`npx site-use` 能启动 MCP server 进程。

**架构：** 全新 TypeScript ESM 项目。MCP server 使用 `@modelcontextprotocol/sdk` + stdio 传输。源码在 `src/`，编译到 `dist/`。配置模块从环境变量读取数据目录和代理设置（`.env` 文件存放私有变量）。定义三个基础错误类型供所有层使用。

**技术栈：** TypeScript, Node.js (ESM), pnpm, `@modelcontextprotocol/sdk`, `puppeteer`, `zod`, `vitest`, `dotenv`

**规格文档：** `docs/milestones/m1/01-project-scaffolding.md`（能力 5），交叉引用 `docs/milestones/m1/02-browser.md`（config.ts、errors.ts 章节）

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `package.json` | ESM 项目配置、依赖、bin 入口、pnpm scripts |
| `tsconfig.json` | TypeScript 编译配置（ES2022, Node16 模块） |
| `.gitignore` | 忽略构建产物、Chrome profile、SQLite 数据库、.env、superpowers 中间文档 |
| `.env.example` | 环境变量模板（提交到 git，给新开发者参考） |
| `.env` | 私有环境变量（不提交，.gitignore 忽略） |
| `src/index.ts` | bin 入口：导入 server，调用 `main()` |
| `src/server.ts` | MCP server 骨架：stdio 传输，启动监听 |
| `src/config.ts` | 配置模块：数据目录、代理设置（从环境变量读取，dotenv 加载 .env） |
| `src/errors.ts` | 三个错误类型：`BrowserDisconnected`、`SessionExpired`、`ElementNotFound` |
| `tests/unit/config.test.ts` | config.ts 单元测试 |
| `tests/unit/errors.test.ts` | errors.ts 单元测试 |
| `tests/contract/server.test.ts` | MCP server 契约测试：验证 server 能正确创建和连接 |

---

## Task 1: 初始化 package.json 和 pnpm

**Files:**
- Create: `package.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "site-use",
  "version": "0.1.0",
  "description": "Site-level browser automation via MCP — deterministic workflows for Chrome, so AI can focus on content understanding.",
  "type": "module",
  "bin": {
    "site-use": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:unit": "vitest run tests/unit",
    "test:contract": "vitest run tests/contract",
    "test:watch": "vitest"
  },
  "keywords": ["mcp", "browser-automation", "twitter", "puppeteer"],
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.8.0",
    "dotenv": "^16.4.7",
    "puppeteer": "^24.4.0",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "typescript": "^5.8.2",
    "vitest": "^3.0.9"
  }
}
```

> **注意：** 版本号以安装时实际最新版为准。上述版本是 2026 年 3 月的合理选择。

- [ ] **Step 2: 运行 pnpm install**

Run: `pnpm install`
Expected: `node_modules/` 创建成功，`pnpm-lock.yaml` 生成，无报错。

- [ ] **Step 3: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: initialize package.json with pnpm

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
"
```

---

## Task 2: 配置 TypeScript、.gitignore 和 .env

**Files:**
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `.env`

- [ ] **Step 1: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*"]
}
```

关键决策：
- `target: ES2022` — 支持 top-level await、Promise.allSettled，Node 18+ 均支持
- `module: Node16` + `moduleResolution: Node16` — ESM 项目推荐配置，正确处理 `.js` 扩展名
- `rootDir: src` — 只从 `src/` 编译
- `declaration: true` — 生成 `.d.ts` 类型声明

- [ ] **Step 2: 创建 .gitignore**

```
node_modules/
dist/

# Private environment variables
.env

# Chrome user data (contains cookies, login state)
chrome-profile/

# SQLite fingerprint databases (M4)
*.db

# Local site-use data directory
.site-use/

# CocoIndex code search cache
.cocoindex_code/

# Superpowers intermediate process docs
docs/superpowers/
```

- [ ] **Step 3: 创建 .env.example（提交到 git 的模板）**

```bash
# site-use environment variables
# Copy this file to .env and fill in your values

# Data directory (default: ~/.site-use/)
# SITE_USE_DATA_DIR=

# Proxy for accessing Twitter (required in China)
# SITE_USE_PROXY=http://127.0.0.1:7890
# SITE_USE_PROXY=socks5://127.0.0.1:1080
# SITE_USE_PROXY_USER=
# SITE_USE_PROXY_PASS=
```

- [ ] **Step 4: 创建 .env（本地私有，不提交）**

从 `.env.example` 复制并填入实际值：

Run: `cp .env.example .env`
然后手动编辑 `.env` 填入代理地址等私有配置。

- [ ] **Step 5: 验证 TypeScript 编译器可用**

Run: `pnpm exec tsc --noEmit`
Expected: 无报错（还没有源文件，退出码 0 或 "no input files" 提示均可）

- [ ] **Step 6: 提交**

```bash
git add tsconfig.json .gitignore .env.example
git commit -m "chore: add tsconfig.json, .gitignore, and .env.example

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
"
```

---

## Task 3: 实现 config.ts 及测试

**Files:**
- Create: `src/config.ts`
- Create: `tests/unit/config.test.ts`

- [ ] **Step 1: 编写 config.ts 的失败测试**

```typescript
// tests/unit/config.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getConfig } from '../../src/config.js';

describe('getConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns default data directory when SITE_USE_DATA_DIR is not set', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '');
    const config = getConfig();
    // 默认值是 ~/.site-use/ — 检查路径以 .site-use 结尾
    expect(config.dataDir).toMatch(/[/\\]\.site-use$/);
  });

  it('uses SITE_USE_DATA_DIR when set', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '/custom/data');
    const config = getConfig();
    expect(config.dataDir).toBe('/custom/data');
  });

  it('derives chromeProfileDir from dataDir', () => {
    vi.stubEnv('SITE_USE_DATA_DIR', '/custom/data');
    const config = getConfig();
    expect(config.chromeProfileDir).toMatch(/[/\\]chrome-profile$/);
    expect(config.chromeProfileDir).toContain('/custom/data');
  });

  it('returns no proxy when SITE_USE_PROXY is not set', () => {
    vi.stubEnv('SITE_USE_PROXY', '');
    const config = getConfig();
    expect(config.proxy).toBeUndefined();
  });

  it('parses proxy config from environment variables', () => {
    vi.stubEnv('SITE_USE_PROXY', 'http://127.0.0.1:7890');
    vi.stubEnv('SITE_USE_PROXY_USER', 'user');
    vi.stubEnv('SITE_USE_PROXY_PASS', 'pass');
    const config = getConfig();
    expect(config.proxy).toEqual({
      server: 'http://127.0.0.1:7890',
      username: 'user',
      password: 'pass',
    });
  });

  it('returns proxy without auth when only SITE_USE_PROXY is set', () => {
    vi.stubEnv('SITE_USE_PROXY', 'socks5://127.0.0.1:1080');
    vi.stubEnv('SITE_USE_PROXY_USER', '');
    vi.stubEnv('SITE_USE_PROXY_PASS', '');
    const config = getConfig();
    expect(config.proxy).toEqual({
      server: 'socks5://127.0.0.1:1080',
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL — `getConfig` 未找到 / 模块不存在

- [ ] **Step 3: 实现 config.ts**

```typescript
// src/config.ts
import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface Config {
  dataDir: string;
  chromeProfileDir: string;
  proxy?: ProxyConfig;
}

export function getConfig(): Config {
  const dataDir =
    process.env.SITE_USE_DATA_DIR || path.join(os.homedir(), '.site-use');
  const chromeProfileDir = path.join(dataDir, 'chrome-profile');

  let proxy: ProxyConfig | undefined;
  const proxyServer = process.env.SITE_USE_PROXY;
  if (proxyServer) {
    proxy = { server: proxyServer };
    const username = process.env.SITE_USE_PROXY_USER;
    const password = process.env.SITE_USE_PROXY_PASS;
    if (username) {
      proxy.username = username;
    }
    if (password) {
      proxy.password = password;
    }
  }

  return { dataDir, chromeProfileDir, proxy };
}
```

> **注意：** `import 'dotenv/config'` 放在 config.ts 顶部，确保 `.env` 文件在读取 `process.env` 之前被加载。这是 dotenv 推荐的 ESM 用法。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:unit`
Expected: 全部 6 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: add config module with env var parsing and tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
"
```

---

## Task 4: 实现 errors.ts 及测试

**Files:**
- Create: `src/errors.ts`
- Create: `tests/unit/errors.test.ts`

- [ ] **Step 1: 编写 errors.ts 的失败测试**

```typescript
// tests/unit/errors.test.ts
import { describe, it, expect } from 'vitest';
import {
  SiteUseError,
  BrowserDisconnected,
  SessionExpired,
  ElementNotFound,
} from '../../src/errors.js';

describe('SiteUseError', () => {
  it('is an instance of Error', () => {
    const err = new SiteUseError('test', 'something failed');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('something failed');
    expect(err.type).toBe('test');
  });

  it('carries error context', () => {
    const err = new SiteUseError('test', 'failed', {
      url: 'https://x.com/home',
      step: 'navigate',
    });
    expect(err.context.url).toBe('https://x.com/home');
    expect(err.context.step).toBe('navigate');
  });
});

describe('BrowserDisconnected', () => {
  it('has correct type', () => {
    const err = new BrowserDisconnected('Chrome crashed');
    expect(err.type).toBe('BrowserDisconnected');
    expect(err.message).toBe('Chrome crashed');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('SessionExpired', () => {
  it('has correct type and carries URL context', () => {
    const err = new SessionExpired('Not logged in', {
      url: 'https://x.com/login',
    });
    expect(err.type).toBe('SessionExpired');
    expect(err.context.url).toBe('https://x.com/login');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});

describe('ElementNotFound', () => {
  it('has correct type and carries step context', () => {
    const err = new ElementNotFound('Follow button not found', {
      url: 'https://x.com/someuser',
      step: 'followUser',
    });
    expect(err.type).toBe('ElementNotFound');
    expect(err.context.step).toBe('followUser');
    expect(err).toBeInstanceOf(SiteUseError);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:unit`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 errors.ts**

```typescript
// src/errors.ts

export interface ErrorContext {
  url?: string;
  step?: string;
  snapshotSummary?: string;
  screenshotBase64?: string; // M3 enhancement, field reserved now
}

export class SiteUseError extends Error {
  readonly type: string;
  readonly context: ErrorContext;

  constructor(type: string, message: string, context: ErrorContext = {}) {
    super(message);
    this.name = 'SiteUseError';
    this.type = type;
    this.context = context;
  }
}

export class BrowserDisconnected extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('BrowserDisconnected', message, context);
    this.name = 'BrowserDisconnected';
  }
}

export class SessionExpired extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('SessionExpired', message, context);
    this.name = 'SessionExpired';
  }
}

export class ElementNotFound extends SiteUseError {
  constructor(message: string, context: ErrorContext = {}) {
    super('ElementNotFound', message, context);
    this.name = 'ElementNotFound';
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:unit`
Expected: 全部 5 个测试 PASS

- [ ] **Step 5: 提交**

```bash
git add src/errors.ts tests/unit/errors.test.ts
git commit -m "feat: add error types (BrowserDisconnected, SessionExpired, ElementNotFound) with tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
"
```

---

## Task 5: 实现 MCP server 骨架及契约测试

**Files:**
- Create: `src/server.ts`
- Create: `src/index.ts`
- Create: `tests/contract/server.test.ts`

- [ ] **Step 1: 实现 server.ts — 带 stdio 传输的 MCP server**

```typescript
// src/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'site-use',
    version: '0.1.0',
  });

  // Tool registration will be added in subsequent capabilities.
  // M1 tools: twitter_check_login, twitter_timeline, screenshot

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 2: 实现 index.ts — bin 入口**

```typescript
#!/usr/bin/env node
// src/index.ts
import { main } from './server.js';

main().catch((err) => {
  console.error('site-use failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 3: 编写 MCP server 契约测试**

契约测试验证 server 满足 MCP 协议契约——能创建、能通过 transport 连接、能响应 initialize 请求。不依赖真实 Chrome 或 stdio。

```typescript
// tests/contract/server.test.ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';

describe('MCP Server contract', () => {
  it('responds to initialize with server info', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    // If connect succeeds, the MCP handshake (initialize) completed.
    // Verify server reported its identity.
    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe('site-use');

    await client.close();
    await server.close();
  });

  it('lists tools (empty in scaffolding phase)', async () => {
    const server = createServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    const result = await client.listTools();
    // Scaffolding phase: no tools registered yet.
    // This test will be updated as tools are added.
    expect(result.tools).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);

    await client.close();
    await server.close();
  });
});
```

> **注意：** `InMemoryTransport` 是 MCP SDK 提供的测试工具，创建一对内存中的 linked transport，无需 stdio 进程。`createLinkedPairs` 或 `createLinkedPair` 的确切 API 名称以 SDK 实际导出为准——如果编译报错，检查 `@modelcontextprotocol/sdk` 的导出并调整。

- [ ] **Step 4: 构建项目**

Run: `pnpm run build`
Expected: `dist/` 目录创建，包含 `index.js`、`server.js`、`config.js`、`errors.js`。无编译错误。

- [ ] **Step 5: 运行全部测试（单元 + 契约）**

Run: `pnpm test`
Expected: 所有测试通过（config.test.ts + errors.test.ts + server.test.ts）

- [ ] **Step 6: 验证 bin 入口可运行**

Run: `node -e "const cp = require('child_process'); const p = cp.spawn('node', ['dist/index.js']); setTimeout(() => { p.kill(); console.log('OK: server started without crash'); }, 2000);" 2>&1`
Expected: 输出 "OK: server started without crash"，无崩溃错误。

> **注意：** 使用 Node.js 脚本替代 Unix `timeout` 命令，兼容 Windows。

- [ ] **Step 7: 提交**

```bash
git add src/server.ts src/index.ts tests/contract/server.test.ts
git commit -m "feat: add MCP server skeleton with contract tests

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
"
```

---

## Task 6: 端到端验证

最终验证一切可以协同工作。

**Files:**
- 无（仅验证）

- [ ] **Step 1: 清理重新构建**

Run: `rm -rf dist && pnpm run build`
Expected: 编译通过，`dist/` 包含所有 `.js` 和 `.d.ts` 文件

- [ ] **Step 2: 运行全部测试**

Run: `pnpm test`
Expected: 所有测试通过（unit + contract）

- [ ] **Step 3: 验证目录结构符合规格**

Run: `find src tests -type f | sort`
Expected:
```
src/config.ts
src/errors.ts
src/index.ts
src/server.ts
tests/contract/server.test.ts
tests/unit/config.test.ts
tests/unit/errors.test.ts
```

没有空目录、没有占位文件。只有在 M1 中有实际用途的文件。

- [ ] **Step 4: 验证 .gitignore 生效**

Run: `git status`
Expected: `.env` 和 `docs/superpowers/` 不出现在 untracked files 中。`.env.example` 已提交。

- [ ] **Step 5: 最终提交（如有调整）**

仅在前面步骤需要修复时提交。否则跳过。
