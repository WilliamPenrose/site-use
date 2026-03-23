# M6 阶段 1：存储 + 结构化检索 + 全文搜索

> 上游：[00-raw-data-archive.md](00-raw-data-archive.md)
> 状态：设计完成
> 日期：2026-03-23

## 解决的问题

"上周看到的推文再也找不到了。"

## 目标

每次 `twitter_timeline` 抓取的推文自动落盘到本地 SQLite。用户通过 CLI（`npx site-use search`）检索历史。不涉及 embedding、不依赖外部服务、不调用 LLM。

## 新增依赖

无新 npm 依赖。使用 `node:sqlite`（Node.js 22+ 内置模块，`DatabaseSync` 同步 API），与 OpenClaw 一致。零安装、零编译。

`sqlite-vec` 留给阶段 2。

## 交付物

| 交付物 | 说明 |
|--------|------|
| `src/storage/` 模块 | 独立可插拔的存储层：types, schema, index, ingest, query |
| `src/sites/twitter/store-adapter.ts` | Tweet → IngestItem 类型转换 |
| `workflows.ts` 修改 | getTimeline 末尾同步调用 store.ingest |
| `src/cli/knowledge.ts` | search / stats CLI 子命令 |
| `src/index.ts` 修改 | 在现有 switch/case 中增加 search/stats 路由 |
| SQLite schema | items 主表 + twitter_meta + 关联表 + FTS5 |
| 测试 | 13 个测试用例（去重、提取、FTS、结构化查询、CLI、并发访问） |

---

## 存储接口

存储层是独立模块（`src/storage/`），MCP Server 和 CLI 都消费它。未来可替换实现，只需满足相同接口。

```ts
// src/storage/types.ts

interface KnowledgeStore {
  ingest(items: IngestItem[]): Promise<IngestResult>;
  search(params: SearchParams): Promise<SearchResult>;
  stats(): Promise<StoreStats>;
  rebuild(opts?: { model?: string }): Promise<RebuildResult>;  // Phase 2
  close(): void;
}

function createStore(dbPath: string): KnowledgeStore;

interface IngestItem {
  site: string;                          // "twitter" | "reddit" | ...
  id: string;                            // unique within site
  text: string;
  author: string;                        // site-level handle (e.g. "elonmusk"), not display name
  timestamp: string;                     // ISO 8601
  url: string;
  rawJson: string;                       // complete original data, zero information loss
  siteMeta?: Record<string, unknown>;    // site-specific fields (e.g. likes, is_retweet)
}

interface IngestResult {
  inserted: number;
  duplicates: number;
  timeRange?: { from: string; to: string };  // ISO 8601, of newly inserted items only; null when inserted=0
}

interface SearchParams {
  query?: string;                        // FTS keyword search (Phase 1), hybrid search (Phase 2)
  site?: string;
  author?: string;
  since?: string;                        // ISO 8601
  until?: string;                        // ISO 8601
  limit?: number;                        // default 20
  orderBy?: 'time' | 'relevance';       // default 'time' in Phase 1
  siteFilters?: Record<string, unknown>; // site-specific filters, see "Site Filter Registry" below
}

interface SearchResult {
  items: SearchResultItem[];
  total: number;                         // total matches before limit (enables pagination)
}

interface SearchResultItem {
  id: string;
  site: string;
  text: string;
  author: string;
  timestamp: string;
  url: string;
  score?: number;                        // Phase 2 hybrid search
  snippet?: string;                      // FTS highlight
  siteMeta?: Record<string, unknown>;
}

interface StoreStats {
  totalItems: number;
  bySite: Record<string, number>;        // { twitter: 3200 }
  uniqueAuthors: number;
  timeRange: { from: string; to: string } | null;
  embeddingModel: string | null;         // Phase 2
  embeddingCoverage: number;             // Phase 2: percentage of items with embedding
}
```

### 站点筛选注册表

`siteFilters` 在通用接口中类型为 `Record<string, unknown>`。每个站点定义自己接受的键和类型：

| 站点 | CLI 参数 | siteFilters 键 | 类型 | SQL 映射 |
|------|----------|----------------|------|----------|
| twitter | `--hashtag` | `hashtag` | `string` | `JOIN item_hashtags WHERE tag = ?` |
| twitter | `--min-likes` | `minLikes` | `number` | `JOIN twitter_meta WHERE likes >= ?` |
| twitter | `--min-retweets` | `minRetweets` | `number` | `JOIN twitter_meta WHERE retweets >= ?` |

未来站点增加自己的行。未知键会产生 `InvalidFilter` 错误，hint 中列出可用筛选项。

### 异步说明

所有接口方法返回 `Promise`，为阶段 2（embedding 真正需要异步）预留兼容性。阶段 1 的实现将同步 `node:sqlite`（DatabaseSync）调用包装在 resolved Promise 中。调用方应始终 await。

---

## SQLite Schema

数据库文件：`~/.site-use/data/knowledge.db`

### 初始化

```sql
PRAGMA journal_mode = WAL;       -- CLI read + MCP Server write concurrency
PRAGMA foreign_keys = ON;        -- enforce referential integrity
PRAGMA busy_timeout = 5000;      -- retry on lock for 5 seconds
```

### 核心表（所有站点共享）

```sql
CREATE TABLE items (
  id              TEXT NOT NULL,
  site            TEXT NOT NULL,
  text            TEXT NOT NULL,
  author          TEXT NOT NULL,       -- site-level handle (e.g. "elonmusk")
  timestamp       TEXT NOT NULL,
  url             TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  embedding_model TEXT,                -- NULL until Phase 2
  ingested_at     TEXT NOT NULL,       -- dual temporality: event time (timestamp) + ingest time
  PRIMARY KEY (site, id)
);

CREATE INDEX idx_items_author ON items(site, author);
CREATE INDEX idx_items_timestamp ON items(site, timestamp);
```

> `author` 存 handle 而非 display name。display name 可从 `raw_json` 恢复。handle 稳定（很少变）且可搜索（`--author elonmusk`）。

### 站点专属表（Class Table Inheritance）

```sql
CREATE TABLE twitter_meta (
  item_id     TEXT NOT NULL,
  site        TEXT NOT NULL DEFAULT 'twitter',
  likes       INTEGER,
  retweets    INTEGER,
  replies     INTEGER,
  views       INTEGER,
  bookmarks   INTEGER,
  quotes      INTEGER,
  is_retweet  INTEGER NOT NULL DEFAULT 0,
  is_ad       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site, item_id),
  FOREIGN KEY (site, item_id) REFERENCES items(site, id)
);
```

包含 `TweetMetricsSchema` 的全部 6 个指标字段。未来新站点加 `xxx_meta` 表，核心表不动。

### 关联表（正则从文本中提取）

```sql
CREATE TABLE item_mentions (
  site    TEXT NOT NULL,
  item_id TEXT NOT NULL,
  handle  TEXT NOT NULL,
  PRIMARY KEY (site, item_id, handle),
  FOREIGN KEY (site, item_id) REFERENCES items(site, id)
);
CREATE INDEX idx_mentions_handle ON item_mentions(handle);

CREATE TABLE item_hashtags (
  site    TEXT NOT NULL,
  item_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (site, item_id, tag),
  FOREIGN KEY (site, item_id) REFERENCES items(site, id)
);
CREATE INDEX idx_hashtags_tag ON item_hashtags(tag);
```

复合主键防止重复 mention/hashtag 行。使用 `INSERT OR IGNORE`。

### 全文搜索（阶段 1 即构建）

```sql
CREATE VIRTUAL TABLE items_fts USING fts5(
  text,
  id UNINDEXED,
  site UNINDEXED,
  author UNINDEXED,
  timestamp UNINDEXED
);
```

FTS5 维护成本低（每次 ingest 一条额外 INSERT），使 CLI 搜索立即可用。`author` 在 FTS 中标记为 UNINDEXED —— 作者搜索走结构化 `WHERE author = ?` 更精准。

### 阶段 2 新增表（阶段 1 不构建）

```sql
-- sqlite-vec vector table
CREATE VIRTUAL TABLE items_vec USING vec0(
  id TEXT PRIMARY KEY,           -- "site:item_id" composite key to avoid cross-site collisions
  embedding FLOAT[384]           -- dimension varies by model
);

-- embedding cache (avoid recomputing on rebuild)
CREATE TABLE embedding_cache (
  model        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding    TEXT NOT NULL,     -- JSON serialized Float32Array
  dims         INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (model, content_hash)
);

-- key-value metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- stores: current embedding model, vector dimensions, last rebuild time
```

### 删除 / 清理

阶段 1 不做删除。未来添加过期/清理功能时，必须级联到：`twitter_meta`、`item_mentions`、`item_hashtags` 和 `items_fts`。实现方式：SQL trigger（优选）或应用层级联。

---

## 文件结构

```
src/
  storage/
    types.ts              — KnowledgeStore interface + all type definitions
    index.ts              — createStore(dbPath) factory, assembles modules
    schema.ts             — CREATE TABLE DDL + PRAGMA initialization + migration logic
    ingest.ts             — insert + dedup + extract mentions/hashtags + FTS write
    query.ts              — structured query + FTS search + (Phase 2: hybrid)
    embedding.ts          — Phase 2: transformers.js + cache + rebuild

  sites/twitter/
    store-adapter.ts      — Tweet[] → IngestItem[] conversion (new)
    workflows.ts          — getTimeline calls store.ingest at the end (modified)

  cli/
    knowledge.ts          — search / stats / rebuild subcommands

  index.ts                — entry point: adds search/stats/rebuild to existing switch/case
```

### 模块边界

| 模块 | 职责 | 依赖 |
|------|------|------|
| `storage/types.ts` | 接口定义 | 无 |
| `storage/schema.ts` | DDL + PRAGMAs + migration | node:sqlite (DatabaseSync) |
| `storage/ingest.ts` | 写入 items + site meta + FTS + 关联表 | schema |
| `storage/query.ts` | 读取：结构化 + FTS +（阶段 2: hybrid） | schema, (阶段 2: embedding) |
| `storage/embedding.ts` | 阶段 2: transformers.js + cache | transformers.js |
| `storage/index.ts` | 组装模块，返回 KnowledgeStore | 所有 storage 模块 |
| `twitter/store-adapter.ts` | Tweet → IngestItem 转换 | 仅 storage/types |
| `cli/knowledge.ts` | 解析 CLI 参数，调用 store 接口 | 仅 storage/index |

**关键隔离：**
- storage 不知道 Twitter 的存在
- twitter/store-adapter.ts 不知道 SQLite 的存在
- cli/knowledge.ts 不知道浏览器的存在

### Store adapter 说明

`store-adapter.ts` 将 `Tweet[]` 映射为 `IngestItem[]`：
- `IngestItem.author` = `Tweet.author.handle`（display name 在 rawJson 中）
- `IngestItem.siteMeta` = `{ likes, retweets, replies, views, bookmarks, quotes, isRetweet, isAd }`
- 正则提取 `@mentions` 和 `#hashtags`
- `Tweet.media`（photos/videos/gifs）**不**纳入结构化存储 —— 媒体 URL 是临时的，仅保留在 `rawJson` 中

---

## 数据流

### 写入（每次 twitter_timeline 调用自动执行）

```
twitter_timeline returns Tweet[]
  │
  ├── store-adapter.ts: Tweet[] → IngestItem[]
  │     ├── map Tweet fields to IngestItem (author = handle)
  │     ├── regex extract @mentions from text
  │     ├── regex extract #hashtags from text
  │     ├── media deliberately excluded from structured fields
  │     └── serialize full Tweet as rawJson (zero information loss)
  │
  ├── store.ingest(items)                          ← synchronous node:sqlite (DatabaseSync), ~50ms for 30 tweets
  │     ├── BEGIN TRANSACTION
  │     ├── for each item:
  │     │     ├── INSERT OR IGNORE INTO items      ← dedup by (site, id)
  │     │     ├── check changes() > 0              ← was it actually inserted?
  │     │     ├── if inserted:
  │     │     │     ├── INSERT OR IGNORE INTO twitter_meta
  │     │     │     ├── INSERT OR IGNORE INTO item_mentions (for each @mention)
  │     │     │     ├── INSERT OR IGNORE INTO item_hashtags (for each #tag)
  │     │     │     └── INSERT INTO items_fts      ← FTS5 (only if item was new)
  │     │     └── if not inserted: increment duplicates count
  │     ├── COMMIT
  │     └── return { inserted, duplicates, timeRange }  ← timeRange from newly inserted items only
  │
  └── return TimelineResult to agent               ← agent does not wait for anything else
```

FTS5 INSERT **以 items INSERT 实际插入为条件**（通过 `changes()` 返回值检查）。这防止了 FTS 重复行，因为 FTS5 虚表不支持 INSERT OR IGNORE。

### 检索（CLI: `npx site-use search`）

```
npx site-use search "AI agent" --author elonmusk --since 2026-03-01
  │
  ├── parse args → SearchParams
  │
  ├── store.search(params)
  │     ├── if query: FTS5 MATCH → BM25 ranked results
  │     ├── if author/since/until: SQL WHERE on items table
  │     ├── if siteFilters.hashtag: JOIN item_hashtags
  │     ├── if siteFilters.minLikes: JOIN twitter_meta WHERE likes >= ?
  │     └── combine: FTS results filtered by structured conditions
  │
  └── output
        ├── default: human-readable formatted text (stdout)
        └── --json: JSON array (stdout)
        └── errors: JSON with hint (stderr)
```

---

## 去重策略

主键 `(site, id)` + `INSERT OR IGNORE`。同一推文多次抓取静默跳过。关联表和 FTS5 仅在新插入时写入（见数据流）。

**指标更新：** 如果同一推文再次抓取时指标变化（更多 likes），当前设计忽略更新。阶段 1 可接受 —— 首次抓取的 raw_json 已保留。如果指标追踪变得重要，未来可对 twitter_meta 单独使用 `INSERT OR REPLACE`。

---

## 与 twitter_timeline 的集成

`workflows.ts` 最小改动：

```ts
// At the end of getTimeline(), after tweets are collected:
const store = getOrCreateStore();  // lazy singleton, same pattern as browser
const items = tweetToIngestItems(tweets);  // from store-adapter.ts
await store.ingest(items);
// return result to agent (ingest is already done)
```

store 是懒加载单例 —— 首次使用时创建，跨调用复用，进程退出时关闭。与 `browser.ts` 中的浏览器单例模式一致。

---

## CLI 接口

### 入口路由

融入现有 `src/index.ts` 的 switch/case：

```ts
// In the existing switch(command) block in run():
case 'search':
case 'stats':
case 'rebuild':
  await runKnowledgeCli(command, args.slice(1));
  break;
```

`npx site-use`（无子命令）显示帮助（现有行为，不是 MCP server）。MCP server 通过 `npx site-use serve` 或 `npx site-use mcp` 启动。帮助文本更新以包含新命令。

### 命令

```bash
# FTS 关键词搜索
npx site-use search "AI agent"

# 结构化筛选
npx site-use search --author elonmusk --since 2026-03-01 --until 2026-03-20

# 组合查询
npx site-use search "AI agent" --author elonmusk --limit 10

# 站点特有筛选
npx site-use search --hashtag AI --min-likes 100

# JSON 输出（供 agent 消费）
npx site-use search "AI agent" --json

# 存储统计
npx site-use stats
npx site-use stats --json
```

### 输出格式

**人类可读（默认，stdout）：**

```
@elonmusk · 2026-03-20 14:32
AI agents are going to reshape how we interact with software...
likes: 42,103  retweets: 8,241  replies: 3,102
https://x.com/elonmusk/status/1234567890
───────────────────────────────────
@vitalikbuterin · 2026-03-19 09:15
The future of autonomous AI agent systems depends on...
likes: 1,287  retweets: 324  replies: 156
https://x.com/vitalikbuterin/status/9876543210

Found 2 results (searched 3,200 items)
```

**JSON（--json 参数，stdout）：**

```json
{
  "items": [
    {
      "id": "1234567890",
      "site": "twitter",
      "text": "AI agents are going to reshape...",
      "author": "elonmusk",
      "timestamp": "2026-03-20T14:32:00Z",
      "url": "https://x.com/elonmusk/status/1234567890",
      "siteMeta": { "likes": 42103, "retweets": 8241, "replies": 3102, "views": 892301 }
    }
  ],
  "total": 2
}
```

`total` 是 `limit` 应用**之前**的匹配总数，支持分页：`total > limit` 时调用方知道还有更多结果。

### 错误输出（stderr，带 agent hint）

错误以 JSON 格式输出到 stderr，包含 `hint` 字段指引 agent 下一步：

```json
{
  "error": "DatabaseNotFound",
  "message": "Knowledge database not found at ~/.site-use/data/knowledge.db",
  "hint": "Run 'npx site-use serve' and fetch some tweets first with twitter_timeline to populate the database."
}
```

```json
{
  "error": "NoResults",
  "message": "No items match the search criteria",
  "hint": "Try broadening filters: remove --author or --since, or use a shorter query."
}
```

```json
{
  "error": "InvalidFilter",
  "message": "Unknown site filter 'subreddit' for site 'twitter'",
  "hint": "Available twitter filters: hashtag, min-likes, min-retweets. Run 'npx site-use search --help' for details."
}
```

退出码：0 = 成功，1 = 错误（stderr 带 hint）。

---

## 测试策略

| 测试 | 类型 | 验证内容 |
|------|------|----------|
| ingest dedup | unit | 同一推文插入两次 → inserted=1, duplicates=1 |
| ingest extraction | unit | @mentions 和 #hashtags 正确解析 |
| ingest FTS guard | unit | 重复 ingest 不产生重复 FTS5 行 |
| search structured | unit | 按 author、时间范围、hashtag 筛选返回正确结果 |
| search FTS | unit | 关键词搜索对相关推文排名更高 |
| search combined | unit | FTS + 结构化筛选正确交叉 |
| search total | unit | total 反映所有匹配，items 遵循 limit |
| store-adapter | unit | Tweet → IngestItem 映射无损（rawJson 包含一切） |
| store-adapter media | unit | media 字段不在 siteMeta 中，保留在 rawJson |
| concurrent access | integration | CLI 搜索在 MCP server 写入时成功（WAL 模式） |
| CLI integration | integration | `npx site-use search` 返回预期输出格式 |
| CLI --json | integration | JSON 输出合法且可解析 |
| CLI stderr | integration | 错误在 stderr 产生 hint，退出码 1 |

---

## 对阶段 2 的零改动承诺

- 存储接口（`KnowledgeStore`）不变 — 阶段 2 只加 `embedding.ts`，扩展 `query.ts` 内部实现
- Schema 只加表不改表 — items/twitter_meta/关联表/FTS5 在阶段 1 定型
- CLI search 参数兼容 — `query` 参数升级为混合检索，结构化参数行为不变
- 写入流程 — 阶段 2 在同步写入后追加异步 embedding，不改变同步路径
