# CLI Feed Smart Default 设计

## 背景

当前 `site-use twitter feed` CLI 命令有两种模式：

- **默认（fetch）**：启动浏览器 → 导航到 x.com/home → 拦截 GraphQL → 滚动采集 → 入库 → 返回结果
- **`--local`**：直接查本地知识库，不碰浏览器

问题在于，大多数情况下用户只是想"看看有什么新东西"，不一定需要每次都打开浏览器。浏览器采集耗时 10-30 秒，且需要 Chrome 实例在运行。如果本地数据足够新鲜，直接返回本地数据即可。

## 调研数据

| 指标 | 数值 | 来源 |
|------|------|------|
| 推文互动半衰期 | 24-43 分钟 | Pfeffer et al. AAAI ICWSM 2023 |
| 活跃用户 session 间隔 | 2-3 小时（日均 6-7 次） | RecurPost, Hootsuite |
| Following feed 速率 | 15-25 条/小时（关注 300 账号） | 基于 Pew Research 发推频率推算 |

## 目标用户场景

**主要场景**：每天刷几次看有什么新东西（非实时监控）。

实时监控场景由 cronjob 任务覆盖，可通过参数控制采集频率。

## 设计

### 核心行为

`site-use twitter feed` 不带显式模式标志时，自动判断走 fetch 还是 local。

### 判断逻辑（按优先级）

| 优先级 | 条件 | 动作 |
|--------|------|------|
| 1 | 用户传了 `--fetch` | 强制 fetch |
| 2 | 用户传了 `--local` | 强制 local |
| 3 | 本地无该 tab 的数据 | fetch |
| 4 | 最新数据超过阈值（默认 120 分钟） | fetch |
| 5 | 以上均不满足 | local |

### 新鲜度判断

#### 上次 fetch 时间戳

不依赖知识库中的推文时间戳（推文时间反映的是作者发布时间，不是采集时间；且不同 tab 的数据在知识库中会交叉）。

改为记录每次 fetch 完成的时间，按 site + feed variant 存储。文件位于 `{dataDir}/fetch-timestamps.json`：

```json
{
  "twitter": {
    "following": "2026-03-25T14:30:00Z",
    "for_you": "2026-03-25T12:15:00Z"
  }
}
```

- fetch 成功后写入对应 site + variant 的时间戳
- 文件不存在或对应 key 不存在 → 视为从未 fetch 过（判断逻辑优先级 3）
- 该方案与知识库解耦，不引入任何新 metric 或 schema 变更

#### 多 site 扩展

结构天然支持未来新增 site，每个 site 定义自己的 feed variant：

```json
{
  "twitter": { "following": "...", "for_you": "..." },
  "xiaohongshu": { "discover": "..." }
}
```

存储层不需要知道 variant 的含义，只负责读写时间戳。

#### 提示信息中的条数

"Using cached data (47min old, 23 tweets)" 中的条数来自知识库查询。为此在 store 层新增轻量方法 `countItems(site, metricFilters?)` → `number`，只做 `COUNT(*)`，不解析完整记录。

#### 默认阈值

**120 分钟**。理由：

1. 对齐活跃用户 session 间隔（2-3 小时）
2. 2 小时内 following feed 大约积累 30-50 条新推文，是有意义的增量
3. 不过于激进，避免频繁触发浏览器

#### `--max-age 0`

等价于 `--fetch`（数据永远被视为过期）。允许使用，不做特殊处理。

### 新增 CLI 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `--fetch` | flag | - | 强制从浏览器采集，跳过新鲜度判断 |
| `--max-age <minutes>` | number | 120 | 数据新鲜度阈值（分钟），超过则触发 fetch |

`--local` 保持原有行为不变。

### 用户提示

无论走哪条路径，都通过 stderr 输出一行纯文本提示（非 JSON 格式，区别于错误输出），告知用户当前的决策依据：

```
# 走 local（数据够新）
Using cached data (47min old, 23 tweets). Run with --fetch to force refresh.

# 走 fetch（数据过期）
Local data is stale (3h old). Fetching fresh data...

# 走 fetch（无数据）
No local data for "following" tab. Fetching...

# 强制 fetch
Fetching fresh data (--fetch)...

# 强制 local
Using local data (--local).
```

### 参数冲突处理

`--fetch` 和 `--local` 互斥。同时传递时报错退出：

```
Error: --fetch and --local are mutually exclusive.
```

## MCP 侧变更

### 设计原则

MCP 的 `twitter_feed` 工具**不做** smart default。调用即 fetch，语义保持不变。

理由：AI agent 有能力自己判断数据新鲜度，不需要工具内部隐式决策。显式语义更可预测。但 agent 需要足够的环境信息才能做出好的判断——单靠 search 结果里的推文时间戳不够直观，也浪费 token。

### 新增 `stats` 工具

将现有 CLI 的 `stats` 功能增强后暴露为 MCP 工具，让 agent 一次调用拿到完整的数据环境信息。

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `site` | string | 否 | 只返回指定 site 的统计，不传则返回所有 site |

#### 响应格式

按 site 分组，每个 site 包含存量统计和采集新鲜度：

```json
{
  "twitter": {
    "totalPosts": 1100,
    "uniqueAuthors": 72,
    "oldestPost": "2026-03-20T08:15:00Z",
    "newestPost": "2026-03-25T14:23:00Z",
    "lastCollected": {
      "following": "2026-03-25T13:41:00Z",
      "for_you": "2026-03-25T12:10:00Z"
    }
  },
  "xhs": {
    "totalPosts": 134,
    "uniqueAuthors": 15,
    "oldestPost": "2026-03-22T10:30:00Z",
    "newestPost": "2026-03-25T10:00:00Z",
    "lastCollected": {
      "discover": "2026-03-25T10:00:00Z"
    }
  }
}
```

字段说明：

| 字段 | 来源 | 含义 |
|------|------|------|
| `totalPosts` | `SELECT COUNT(*) FROM items WHERE site = ?` | 该 site 的总存量 |
| `uniqueAuthors` | `SELECT COUNT(DISTINCT author) FROM items WHERE site = ?` | 内容多样性 |
| `oldestPost` / `newestPost` | `SELECT MIN/MAX(timestamp) FROM items WHERE site = ?` | 内容时间跨度（发布时间） |
| `lastCollected` | `fetch-timestamps.json` 中对应 site 的各 variant | 上次采集的时间（按 tab） |

#### agent 决策示例

agent 拿到 stats 后可以自主判断：

- `lastCollected.following` 是 42 分钟前 → 数据新鲜，直接用 `search` 查内容
- `lastCollected.for_you` 是 133 分钟前 → 可以提示用户"for_you 数据有点旧，是否需要刷新？"
- `totalPosts` 为 0 → 该 site 从未采集过，必须先 `twitter_feed`
- 用户问"最近关注的人发了什么" → 看 `lastCollected.following` 判断是否需要刷新，再看 `newestPost` 了解数据覆盖到什么时候

#### 与现有 stats 的关系

现有 `stats()` 函数（`src/storage/query.ts`）返回全局聚合数据。增强方案：

1. **按 site 分组**：将现有 `bySite` 展开为完整的 per-site 统计（authors、time range）
2. **合并 freshness 数据**：读取 `fetch-timestamps.json`，按 site 挂到 `lastCollected` 字段
3. **字段重命名**：使用 agent 友好的命名（`totalPosts` 而非 `totalItems`，`oldestPost`/`newestPost` 而非嵌套的 `timeRange`）

#### tool description

```
stats:
  Show knowledge base statistics per site: post counts, content time range, and when each feed tab was last collected. Use this to decide whether to fetch fresh data or query existing data with search.
```

### 更新 `twitter_feed` description

```
Collect tweets from the Twitter/X home feed.
This launches a browser and takes 10-30s.
Call the stats tool first to check when data was last collected — if recent enough, use search instead.
```

## 实现范围

1. **fetch-timestamps 模块**：读写 `{dataDir}/fetch-timestamps.json` 的工具函数（`getLastFetchTime(site, variant)` / `setLastFetchTime(site, variant)`）
2. **storage 层**：KnowledgeStore 新增 `countItems(site, metricFilters?)` 方法（CLI 提示信息用）
3. **storage 层**：`stats()` 增强为按 site 分组，合并 fetch-timestamps 数据，返回新格式
4. **server.ts**：新增 `stats` MCP 工具，调用增强后的 `stats()`
5. **server.ts**：更新 `twitter_feed` tool description
6. **workflow.ts**：新增 `shouldFetch()` 判断函数，读 fetch-timestamps 文件
7. **workflow.ts**：`parseFeedArgs()` 新增 `--fetch`、`--max-age` 参数解析及互斥校验
8. **workflow.ts**：主流程根据判断结果走 fetch 或 local 分支，输出 stderr 提示；fetch 成功后写入时间戳
9. **测试**：`shouldFetch()` unit test + fetch-timestamps 读写 unit test + stats 增强 unit test
