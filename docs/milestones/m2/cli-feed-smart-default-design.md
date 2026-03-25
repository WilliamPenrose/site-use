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

MCP 的 `twitter_feed` 工具**不做** smart default。调用即 fetch，语义保持不变。

唯一变更：优化 tool description，加上成本提示引导 AI 优先使用 `search`：

```
Collect tweets from the Twitter/X home feed.
This launches a browser and takes 10-30s.
Use the search tool first to check if recently collected data meets your needs.
```

理由：AI agent 有能力自己先调 `search` 判断数据新鲜度，不需要工具内部隐式决策。显式语义更可预测。

## 实现范围

1. **fetch-timestamps 模块**：读写 `{dataDir}/fetch-timestamps.json` 的工具函数（`getLastFetchTime(site, variant)` / `setLastFetchTime(site, variant)`）
2. **storage 层**：KnowledgeStore 新增 `countItems(site, metricFilters?)` 方法（提示信息用）
3. **workflow.ts**：新增 `shouldFetch()` 判断函数，读 fetch-timestamps 文件
4. **workflow.ts**：`parseFeedArgs()` 新增 `--fetch`、`--max-age` 参数解析及互斥校验
5. **workflow.ts**：主流程根据判断结果走 fetch 或 local 分支，输出 stderr 提示；fetch 成功后写入时间戳
6. **server.ts**：更新 `twitter_feed` tool description
7. **测试**：`shouldFetch()` unit test + fetch-timestamps 读写 unit test
