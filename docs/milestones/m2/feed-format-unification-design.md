# Feed 格式统一 + Local 模式

> 日期：2026-03-25
> 状态：设计中

## 问题

`twitter feed` CLI 和 `twitter search` CLI 对同一种数据（推文）使用了两套独立的格式化逻辑。`cli/workflow.ts` 中的 `formatHumanReadable()` 输出较简单；`sites/twitter/format.ts` 中的 `formatTweetText()` 支持 surface context、引用推文、emoji 风格指标等。维护两套 formatter 既浪费又导致输出不一致。

此外，测试 LLM 能力时需要启动浏览器实时抓取推文。增加 `--local` 模式可直接从本地缓存读取，免去浏览器依赖。

## 术语

- **Fetch 模式** — 默认行为，启动浏览器实时抓取 Twitter
- **Local 模式** — `--local` 标志，从知识库缓存读取数据

## 设计

### 1. 格式化统一

**方案：** `Tweet` → `SearchResultItem` 转换，复用 `formatTweetText()`。

在 `sites/twitter/store-adapter.ts` 新增转换函数：

```typescript
export function tweetToSearchResultItem(tweet: Tweet): SearchResultItem {
  return {
    id: tweet.id,
    site: 'twitter',
    text: tweet.text,
    author: tweet.author.handle,
    timestamp: tweet.timestamp,
    url: tweet.url,
    links: tweet.links,
    media: tweet.media,
    siteMeta: {
      likes: tweet.metrics.likes,
      retweets: tweet.metrics.retweets,
      replies: tweet.metrics.replies,
      views: tweet.metrics.views,
      bookmarks: tweet.metrics.bookmarks,
      quotes: tweet.metrics.quotes,
      following: tweet.author.following,
      surfaceReason: tweet.surfaceReason,
      surfacedBy: tweet.surfacedBy,
      quotedTweet: tweet.quotedTweet,
      inReplyTo: tweet.inReplyTo,
    },
  };
}
```

在 `cli/workflow.ts` 中替换 `formatHumanReadable()`：

```typescript
function formatFeedOutput(result: FeedResult): string {
  const items = result.tweets.map(tweetToSearchResultItem);
  const parts = items.map(formatTweetText);
  const body = parts.join('\n\n---\n\n');
  const noun = result.tweets.length === 1 ? 'tweet' : 'tweets';
  const lines = [body, '', `Collected ${result.tweets.length} ${noun}`];

  if (result.debug) {
    const d = result.debug;
    lines.push('', `[debug] tab=${d.tabRequested} nav=${d.navAction} tabAction=${d.tabAction} reload=${d.reloadFallback} graphql=${d.graphqlResponseCount} raw=${d.rawBeforeFilter} elapsed=${d.elapsedMs}ms`);
  }
  return lines.join('\n');
}
```

删除 `workflow.ts` 中的 `formatHumanReadable()` 和 `formatTimestamp()`。

**与入库逻辑的关系：** `tweetToSearchResultItem` 和 `tweetsToIngestItems` 看似相似（都从 Tweet 提取字段），但职责不同——前者面向展示（组装给 formatter），后者面向存储（拆成表列 + metrics + mentions）。两者不应合并，各自只关心自己需要的字段。

**输出变化：**
- 指标风格：`likes: 84  retweets: 3` → `♡ 84  ↻ 3`
- 日期格式：`Mar 25, 2026, 14:30 GMT+8` → `2026-03-25 06:30`（UTC，紧凑格式）
- 分隔符：`───────────────` → `---`
- 新增：surface context 行（retweet by、reply to）
- 新增：引用推文渲染（`┃` 前缀）

### 2. 统一 `--json` 输出

Fetch 模式和 Local 模式使用相同的 JSON 结构：`SearchResultItem[]`。

这是对当前 fetch 模式 `--json` 输出的 breaking change（原来是 `FeedResult`：`{ tweets, meta, debug }`），但目前没有下游消费者。

- Fetch 模式：`result.tweets.map(tweetToSearchResultItem)` → JSON 输出
- Local 模式：`store.search(params).items` → JSON 输出（本身就是 `SearchResultItem[]`）

### 3. `--local` 模式

**CLI 接口：**

```
site-use twitter feed --local [--count N] [--tab following|for_you] [--json]
```

- `--local` 跳过浏览器，直接从知识库读取
- `--debug` 和 `--dump-raw` 在 local 模式下无意义，忽略
- `--count` 和 `--tab` 正常工作
- `--json` 正常工作

**执行流程（local 模式）：**

```
parseFeedArgs(args)
  → 检测 --local 标志
  → 打开 store（不启动浏览器）
  → 构建 SearchParams：
      site: 'twitter'
      max_results: count
      metricFilters: [{ metric: 'following', op: '=', numValue: 1 }]  // 仅当 --tab following
  → store.search(params)
  → formatTweetText 格式化
  → 输出
```

**执行流程（fetch 模式，逻辑不变）：**

```
parseFeedArgs(args)
  → ensureBrowser({ autoLaunch: true })
  → buildPrimitives → getFeed → 入库到 store
  → Tweet[] → SearchResultItem[] 转换
  → formatTweetText 格式化
  → 输出
```

**`--tab following` 近似说明：** Local 模式下，`--tab following` 通过 `author.following = true` 过滤。这是一个近似——真正的 Following tab 是算法推荐的时间线，可能包含非关注用户的转推。由于 store 不记录推文来源 tab，按关注状态过滤是最接近的代理。`--tab for_you`（默认）返回全部缓存推文，不过滤。

### 4. 入库新增 `following` Metric

在 `store-adapter.ts` 的 `tweetsToIngestItems()` 中新增 metric：

```typescript
{ metric: 'following', numValue: tweet.author.following ? 1 : 0 }
```

这使 `--local --tab following` 能在 store 层直接过滤。此改动必须在 local 模式的 `--tab following` 功能之前实现。

### 5. 一次性迁移脚本

临时 Node.js 脚本（`scripts/backfill-following.mjs`），为已有数据补写 `following` metric：

1. 打开知识库数据库
2. 查询 `items` 表中 `site = 'twitter'` 且 `item_metrics` 中无 `following` 记录的条目
3. 解析 `raw_json`，提取 `author.following`
4. 插入 `{ metric: 'following', numValue: following ? 1 : 0 }` 到 `item_metrics`
5. 脚本幂等（可安全重复运行）
6. 运行后删除脚本

## 文件变更

| 文件 | 改动 |
|------|------|
| `sites/twitter/store-adapter.ts` | 新增 `tweetToSearchResultItem()`；入库时增加 `following` metric |
| `cli/workflow.ts` | 删除 `formatHumanReadable`/`formatTimestamp`；新增 `--local` 解析和查询分支；`--json` 输出统一为 `SearchResultItem[]`；格式化走 `formatTweetText` |
| `sites/twitter/format.ts` | 无改动 |
| `server.ts` | 无改动 |
| `scripts/backfill-following.mjs` | 一次性迁移，运行后删除 |

## 非目标

- 修改 MCP server 行为（已使用 `formatTweetText`）
- 增加新的搜索参数
- 将其他字段迁移为 metric（仅 `following` 用于 `--tab` 过滤）
- 在入库时记录来源 tab（following/for_you）
