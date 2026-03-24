# Knowledge Store 架构设计：检索-展现分离

> 更新时间：2026-03-24
> 状态：设计草案，待评审

## 1. 问题陈述

### 现状

当前存储层围绕 Twitter 单站点构建，`twitter_meta` 表包含所有站点特有字段（likes、retweets、following、isRetweet 等），每加一个字段需要修改 8 个文件：

```
types.ts → extractors.ts → store-adapter.ts → schema.ts → ingest.ts → query.ts → formatter → tests
```

### 问题本质

系统没有区分两类本质不同的数据：

| 类型 | 目的 | 举例 | 变更频率 |
|------|------|------|---------|
| 索引数据 | 支持检索、过滤、排序、聚合 | likes >= 1000, author = 'karpathy' | 低（新增过滤能力时） |
| 展现数据 | 供 formatter 展示 | following, isRetweet, flair, noteType | 高（频繁增加展示字段） |

当前架构把两者混在同一管道中，展现数据被强制走完结构化索引的全链路，导致散弹式修改。

### 多站点放大

接入 Reddit、小红书时，如果延续 `*_meta` 模式：

- 每个站点一张 meta 表、一套 INSERT/SELECT/JOIN
- 每个展现字段改全链路
- 复杂度 = 站点数 × 字段数 × 管道层数

---

## 2. 设计目标

1. **加一个展现字段只改 3 个文件**：类型（types）+ 提取层（extractor）+ display schema 加一行声明；消费端零改动
2. **加一个过滤字段改 4 个文件**：提取层 + 索引注册 + 查询条件 + CLI 参数——合理，因为新的查询能力本该改查询层
3. **接入新站点不改存储层**：存储完全站点无关，站点差异只存在于提取和展示两端
4. **旧数据平滑迁移**：`raw_json` 已存完整数据，迁移脚本可回填索引

---

## 3. 核心架构：检索-展现分离

### 3.1 整体流程

```
建库（Ingest）
  Raw Site API → Site Extractor → 写入三类存储
                                    ├── ① 全文索引（FTS）
                                    ├── ② 结构化索引（过滤/排序/聚合）
                                    └── ③ 文档存储（完整原始数据）

查询（Query）
  用户条件 → ① FTS + ② 结构化索引 联合检索 → id 列表
                                                  ↓
                                        ③ 按 id 批量取文档
                                                  ↓
                                        Site Formatter 按需提取展示
```

### 3.2 三类存储

#### ① 全文索引 — `items_fts`（已有，需精简）

职责：文本匹配，返回命中文档的 id。不负责过滤、排序、展现。

```sql
-- 精简：移除 author/timestamp，它们属于结构化过滤，走 items 表的 B-Tree 索引
CREATE VIRTUAL TABLE items_fts USING fts5(
  text,
  id UNINDEXED, site UNINDEXED   -- 仅用于关联回 items 表
);
```

原表中 `author UNINDEXED` 和 `timestamp UNINDEXED` 是为了免 JOIN 的便利性冗余。在检索-展现分离架构下，`author` 过滤走 `items.author`（B-Tree），`timestamp` 排序走 `items.timestamp`（B-Tree），FTS 表不应承担这些职责。

#### ② 结构化索引 — `item_metrics`（新）

职责：支持数值和字符串字段的过滤（WHERE）、排序（ORDER BY）、聚合（COUNT/SUM）。

替代当前的 `twitter_meta`，所有站点共用一张表：

```sql
CREATE TABLE item_metrics (
  site       TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  metric     TEXT    NOT NULL,     -- 指标名：'likes', 'upvotes', 'subreddit'
  num_value  INTEGER,              -- 整数型：likes, retweets, views
  real_value REAL,                 -- 浮点型：upvote_ratio, score
  str_value  TEXT,                 -- 字符串型：subreddit, flair
  PRIMARY KEY (site, item_id, metric),
  FOREIGN KEY (site, item_id) REFERENCES items(site, id)
);

-- 支持 "WHERE metric = 'likes' AND num_value >= 1000" 高效过滤
CREATE INDEX idx_metrics_num  ON item_metrics(site, metric, num_value);
-- 支持 "WHERE metric = 'upvote_ratio' AND real_value >= 0.9" 高效过滤
CREATE INDEX idx_metrics_real ON item_metrics(site, metric, real_value);
-- 支持 "WHERE metric = 'subreddit' AND str_value = 'programming'" 高效过滤
CREATE INDEX idx_metrics_str  ON item_metrics(site, metric, str_value);
```

设计要点：

- **通用 KV 结构**：任何站点加新过滤字段只需在提取层注册，不改 schema
- **三值列**：每行只填 `num_value`、`real_value`、`str_value` 其中一列，其余为 NULL。类型在索引注册时声明
- **仅适用于标量字段**（每条内容一个值）。多值字段见下方关联表
- **为什么不用 JSON + json_extract**：SQLite 的 `json_extract` 无法高效利用索引，大表下过滤性能差。显式列 + B-Tree 索引是更可靠的方案
- **为什么不继续用每站点一张表**：`twitter_meta`、`reddit_meta`、`xhs_meta` 意味着每个站点的 ingest/query 代码都不同，查询层需要 per-site JOIN 逻辑。通用 KV 表让查询逻辑站点无关

#### 关联表 — `item_mentions` / `item_hashtags` / `item_links`（已有）

职责：支持**多值字段**的过滤（一条内容有 N 个 mention、N 个 hashtag、N 个 link）。

`item_metrics` 的主键是 `(site, item_id, metric)`，一条内容每个 metric 只能有一个值，无法表达"这条推文 @了 3 个人"。多值可过滤字段需要独立的关联表。

判断原则——每个字段问两个问题：**标量还是多值？需要独立过滤还是 FTS/展示足够？**

| 字段特征 | 存储位置 | 举例 |
|---------|---------|------|
| 标量 + 需要过滤/排序/聚合 | `item_metrics` | likes, upvote_ratio, subreddit |
| 多值 + 需要精确过滤（FTS 噪声大） | 专用关联表 | mentions（`@X` vs 正文提到 X）、hashtags（`#AI` vs 正文的 AI） |
| 多值 + FTS 可覆盖 | `raw_json`（FTS 搜） | links（展开 URL 已在 text 中） |
| 结构化对象 / 仅展示 | `raw_json` | media, following, isRetweet |

#### ③ 文档存储 — `items.raw_json`（已有）

职责：存储完整的结构化数据，展现时按需提取。

```sql
-- items 表已有 raw_json TEXT NOT NULL 列
-- 不需要改动
```

`raw_json` 存的是 site extractor 输出的完整对象（如 `Tweet` 类型的 JSON），包含所有字段。这是展现数据的唯一来源。

### 3.3 数据流对比

#### 加一个展现字段（如 `following`）

```
改动前（8 文件）              改动后（3 文件）
─────────────────────         ─────────────────────
types.ts          ✎           types.ts          ✎   ← 类型定义
extractors.ts     ✎           extractors.ts     ✎   ← 从 GraphQL 提取
store-adapter.ts  ✎           display.ts        ✎   ← schema 加一行声明
schema.ts         ✎
ingest.ts         ✎           消费端（CLI/MCP）无需改动
query.ts          ✎
formatter         ✎
tests (fixtures)  ✎
```

3 个文件，且 display.ts 的改动只是加一行字段声明。

#### 加一个过滤字段（如 Reddit `--min-upvotes`）

```
extractors.ts              ← 提取 upvotes
store-adapter.ts           ← 注册 { metric: 'upvotes', type: 'number' }
CLI arg parsing            ← 加 --min-upvotes 参数
query.ts                   ← 构建 WHERE metric='upvotes' AND num_value >= ?
```

4 个文件，合理——新的查询能力需要查询层支持。

#### 接入新站点（如 Reddit）

```
sites/reddit/
  types.ts                 ← RedditPost 类型定义
  extractors.ts            ← 从 Reddit API/DOM 提取
  store-adapter.ts         ← 声明哪些字段是 metrics
  display.ts               ← display schema 声明

存储层：零改动
展现引擎：零改动（通用 resolve）
```

---

## 4. 各层详细设计

### 4.1 Ingest 管道

```typescript
interface MetricEntry {
  metric: string;                       // 'likes', 'subreddit', 'upvote_ratio'
  numValue?: number;                    // 整数型
  realValue?: number;                   // 浮点型
  strValue?: string;                    // 字符串型
}

interface IngestItem {
  // ── 文档（items 表 + raw_json） ──
  site: string;
  id: string;
  text: string;                         // 同时写入 items_fts 全文索引
  author: string;
  timestamp: string;
  url: string;
  rawJson: string;                      // 完整文档，展现数据的唯一来源

  // ── 索引 ──
  metrics?: MetricEntry[];              // 标量可过滤字段 → item_metrics
  mentions?: string[];                  // 多值可过滤字段 → item_mentions
  hashtags?: string[];                  // 多值可过滤字段 → item_hashtags

  // links — 展开后的 URL 已在 text 中，FTS 可搜，不需要单独关联表
  // media、following 等展示数据不在此声明
  // 以上均已在 rawJson 中，展现时由 Site Formatter 按需提取
}
```

Store Adapter 的职责变为：声明哪些字段需要索引。

```typescript
// sites/twitter/store-adapter.ts
export function tweetsToIngestItems(tweets: Tweet[]): IngestItem[] {
  return tweets.map((tweet) => ({
    site: 'twitter',
    id: tweet.id,
    text: tweet.text,
    author: tweet.author.handle,
    timestamp: tweet.timestamp,
    url: tweet.url,
    rawJson: JSON.stringify(tweet),      // 完整数据，following 自然包含
    metrics: [                           // 只声明需要索引的字段
      { metric: 'likes',    numValue: tweet.metrics.likes },
      { metric: 'retweets', numValue: tweet.metrics.retweets },
      { metric: 'replies',  numValue: tweet.metrics.replies },
      { metric: 'views',    numValue: tweet.metrics.views },
    ].filter(m => m.numValue != null),
    mentions: extractMentions(tweet.text),
    hashtags: extractHashtags(tweet.text),
    // links、media 等展示数据已在 rawJson 中，不需要单独声明
  }));
}
```

Ingest 逻辑：

```typescript
// storage/ingest.ts — 通用，不含任何站点特有代码
for (const m of item.metrics ?? []) {
  insertMetric.run(item.site, item.id, m.metric,
    m.numValue ?? null, m.realValue ?? null, m.strValue ?? null);
}
```

### 4.2 Query 管道

#### 检索阶段：索引驱动

```typescript
// query.ts — 构建 SQL
// 文本检索条件 → items_fts
// 结构化过滤条件 → item_metrics JOIN

// 举例：search "AI" --min-likes 1000 --author karpathy
//
// SELECT i.id, i.site FROM items i
// JOIN items_fts f ON f.id = i.id AND f.site = i.site
// JOIN item_metrics m1 ON m1.site = i.site AND m1.item_id = i.id
//                     AND m1.metric = 'likes' AND m1.num_value >= 1000
// WHERE i.author = 'karpathy'
//   AND items_fts MATCH 'AI'
// ORDER BY i.timestamp DESC
// LIMIT 20
```

每个数值过滤条件对应一个 `item_metrics` 的 JOIN。通用查询构建器根据 `SearchParams` 动态生成 JOIN，不含站点特有逻辑。

#### 文档获取阶段：raw_json

```typescript
// 检索得到 id 列表后，批量取文档
const docs = db.prepare(`
  SELECT id, site, raw_json FROM items
  WHERE (site, id) IN (${placeholders})
`).all(...ids);
```

#### 展现组装阶段：声明式 Schema + Resolve

采用 GraphQL 启发的模式：每个站点声明一份 display schema（字段名 → JSON 路径 + 可选格式化），
通用 resolve 引擎从 `raw_json` 提取。消费端（CLI / MCP / 未来 Web UI）只声明需要哪些字段。

**resolve 引擎**（约 20 行，无外部依赖）：

```typescript
// display/resolve.ts
function resolve(doc: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((o, k) => (o as any)?.[k], doc);
}

interface FieldDef {
  path: string;                                      // JSON 路径：'author.handle'
  format?: (value: unknown) => string | undefined;   // 可选格式化
}

type DisplaySchema = Record<string, FieldDef>;

function resolveItem(doc: Record<string, unknown>, schema: DisplaySchema, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const def = schema[field];
    if (!def) continue;
    const raw = resolve(doc, def.path);
    result[field] = def.format ? def.format(raw) : raw;
  }
  return result;
}
```

**站点 display schema**（每站点一份声明）：

```typescript
// sites/twitter/display.ts
export const twitterDisplaySchema: DisplaySchema = {
  author:      { path: 'author.handle' },
  authorName:  { path: 'author.name' },
  following:   { path: 'author.following' },
  authorTag:   { path: 'author.following', format: (v) => v === false ? '[not following]' : undefined },
  text:        { path: 'text' },
  timestamp:   { path: 'timestamp' },
  url:         { path: 'url' },
  likes:       { path: 'metrics.likes' },
  retweets:    { path: 'metrics.retweets' },
  replies:     { path: 'metrics.replies' },
  views:       { path: 'metrics.views' },
  isRetweet:   { path: 'isRetweet' },
  media:       { path: 'media' },
  links:       { path: 'links' },
  // 加展示字段 = 这里加一行，所有消费端立刻可用
};
```

**消费端只声明需要哪些字段**：

```typescript
// CLI
const item = resolveItem(doc, twitterDisplaySchema, ['author', 'authorTag', 'text', 'likes', 'retweets']);

// MCP tool（可能需要更多字段）
const item = resolveItem(doc, twitterDisplaySchema, ['author', 'following', 'text', 'likes', 'retweets', 'media']);
```

**加一个展示字段的完整改动**：

```
改动前（8 文件）              改动后
─────────────────────         ─────────────────────
types.ts          ✎           types.ts          ✎   ← 类型定义
extractors.ts     ✎           extractors.ts     ✎   ← 从 GraphQL 提取
store-adapter.ts  ✎           display.ts        ✎   ← schema 加一行
schema.ts         ✎
ingest.ts         ✎           消费端无需改动 —— 按需引用即可
query.ts          ✎
formatter         ✎
tests (fixtures)  ✎
```

### 4.3 CLI 参数注册

当前 `SearchParams` 里的 `min_likes`、`min_retweets` 是硬编码的字段。改为通用的 metric 过滤：

```typescript
interface SearchParams {
  query?: string;
  site?: string;
  author?: string;
  start_date?: string;
  end_date?: string;
  max_results?: number;
  hashtag?: string;
  mention?: string;
  link?: string;
  fields?: SearchField[];
  // 通用 metric 过滤，替代 min_likes、min_retweets 等硬编码字段
  metricFilters?: Array<{
    metric: string;          // 'likes', 'retweets', 'upvote_ratio'
    op: '>=' | '<=' | '=';
    numValue?: number;       // 整数比较
    realValue?: number;      // 浮点比较
    strValue?: string;       // 字符串精确匹配
  }>;
}
```

CLI 参数映射保持用户友好：

```
--min-likes 1000       → { metric: 'likes', op: '>=', numValue: 1000 }
--min-retweets 50      → { metric: 'retweets', op: '>=', numValue: 50 }
--min-upvotes 100      → { metric: 'upvotes', op: '>=', numValue: 100 }   (Reddit)
--subreddit programming → { metric: 'subreddit', op: '=', strValue: 'programming' }
```

新增过滤参数只需：
1. CLI arg parsing 加一行映射
2. 确保 store-adapter 把对应字段写入 metrics

查询构建器自动处理 JOIN 生成——不需要为每个新 metric 写查询代码。

---

## 5. Schema 全览

```sql
-- ① 文档存储（已有，不变）
CREATE TABLE items (
  id              TEXT NOT NULL,
  site            TEXT NOT NULL,
  text            TEXT NOT NULL,
  author          TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  url             TEXT NOT NULL,
  raw_json        TEXT NOT NULL,
  embedding_model TEXT,
  ingested_at     TEXT NOT NULL,
  PRIMARY KEY (site, id)
);
CREATE INDEX idx_items_author    ON items(site, author);
CREATE INDEX idx_items_timestamp ON items(site, timestamp);

-- ② 全文索引（已有，需精简：移除 author/timestamp 冗余列）
CREATE VIRTUAL TABLE items_fts USING fts5(
  text,
  id UNINDEXED, site UNINDEXED
);

-- ③ 结构化索引（新，替代 twitter_meta）
CREATE TABLE item_metrics (
  site       TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  metric     TEXT    NOT NULL,
  num_value  INTEGER,
  real_value REAL,
  str_value  TEXT,
  PRIMARY KEY (site, item_id, metric),
  FOREIGN KEY (site, item_id) REFERENCES items(site, id)
);
CREATE INDEX idx_metrics_num  ON item_metrics(site, metric, num_value);
CREATE INDEX idx_metrics_real ON item_metrics(site, metric, real_value);
CREATE INDEX idx_metrics_str  ON item_metrics(site, metric, str_value);

-- ④ 多值索引（已有，保留）
CREATE TABLE item_mentions  (...);  -- site, item_id, handle   → --mention 过滤
CREATE TABLE item_hashtags  (...);  -- site, item_id, tag      → --hashtag 过滤

-- item_links 移除：展开后的 URL 已在 text 中，FTS 可搜
-- item_media 移除：纯展示数据，从 raw_json 提取
```

---

## 6. 迁移策略

### 6.1 数据迁移

`twitter_meta` 的数据可以从 `items.raw_json` 回填到 `item_metrics`：

```sql
-- 从 raw_json 回填 likes
INSERT INTO item_metrics (site, item_id, metric, num_value)
SELECT 'twitter', id, 'likes', json_extract(raw_json, '$.metrics.likes')
FROM items WHERE site = 'twitter' AND json_extract(raw_json, '$.metrics.likes') IS NOT NULL;

-- retweets, replies, views 等同理
```

### 6.2 兼容过渡

1. 创建 `item_metrics` 表
2. 迁移脚本从 `twitter_meta` 或 `raw_json` 填充 `item_metrics`
3. 切换 query.ts 从 `item_metrics` 查询
4. 确认功能正常后，DROP `twitter_meta`

### 6.3 测试策略

- 现有搜索测试（`cli-knowledge.test.ts`、`storage-query.test.ts`）验证过滤行为不变
- 新增 `item_metrics` 的 ingest/query 单元测试
- 集成测试验证迁移后旧数据可查

---

## 7. 未来扩展

### 7.1 多站点扩展路径

每个新站点只需实现站点目录下的文件，存储层和展现引擎零改动：

```
sites/{site}/
  types.ts           — 站点数据类型（RawPost, RedditComment 等）
  extractors.ts      — 从原始 API/DOM 提取结构化数据
  store-adapter.ts   — 声明 metrics 映射
  display.ts         — display schema 声明（字段路径 + 格式化）
  workflows.ts       — 浏览器自动化流程
  matchers.ts        — ARIA 语义匹配规则
```

### 7.2 Phase 2 语义检索

`items` 表已预留 `embedding_model` 列。向量索引作为第四类索引，与全文索引、结构化索引正交。文档存储（raw_json）不受影响。

### 7.3 聚合查询

`item_metrics` 的 KV 结构天然支持聚合：

```sql
-- 各站点平均点赞数
SELECT site, AVG(num_value) FROM item_metrics
WHERE metric = 'likes' GROUP BY site;

-- 某用户内容的互动趋势
SELECT date(i.timestamp) as day, SUM(m.num_value) as total_likes
FROM items i JOIN item_metrics m ON m.site = i.site AND m.item_id = i.id
WHERE i.author = 'karpathy' AND m.metric = 'likes'
GROUP BY day;
```

---

## 8. 设计决策记录

| 决策 | 选择 | 替代方案 | 理由 |
|------|------|---------|------|
| 展现数据存储 | `raw_json` + 声明式 display schema | 每站点 meta 表 + 命令式 formatter | 加展现字段 = schema 加一行，消费端零改动 |
| 结构化索引 | 通用 KV `item_metrics` | 每站点 meta 表 | 查询逻辑站点无关；新站点零改动 |
| 字段类型 | `num_value` + `real_value` + `str_value` 三列 | JSON + json_extract | B-Tree 索引，过滤性能可预测；预留浮点避免后续改 schema |
| 过滤参数 | 通用 `metricFilters` 数组 | 每字段硬编码 (`min_likes`, `min_retweets`) | 新过滤器只需 CLI 映射，查询构建器自动处理 |
| 迁移方式 | 从 `raw_json` 回填 | 从 `twitter_meta` 拷贝 | `raw_json` 是权威数据源，不依赖旧 schema |

---

## 附录 A：各站点 Metrics 预估

| 站点 | 数值型 Metrics（可过滤） | 字符串型 Metrics（可过滤） | 展现字段（raw_json） |
|------|------------------------|--------------------------|---------------------|
| Twitter | likes, retweets, replies, views, bookmarks, quotes | — | following, isRetweet, isAd, author.name |
| Reddit | upvotes, downvotes, score, numComments | subreddit, flair, postType | isNSFW, isStickied, awardCount, author.karma |
| 小红书 | likes, collects, comments | noteType, location | isSponsored, coverImage, author.level |

所有展现字段通过 `raw_json` 零成本传递，无需 schema 支持。
