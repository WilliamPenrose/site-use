# tweet_detail：推文详情与回复

> 上游：[M2 完整 Twitter 自动化](./00-full-twitter-automation.md)
> 状态：**设计完成，待实现**
> 来源：M2 规划时作为 `getTweetDetail` 被排除（"复杂度高、需求不明确"）。现在有了具体场景："这条推文下大家在讨论什么？"

## 目标

给定一条推文 URL，返回原推（完整文本）及其回复，格式为标准 `FeedResult`。Agent 可以一次调用获取完整讨论上下文，无需手动浏览 Twitter。

## MCP Tool 接口

**工具名**：`twitter_tweet_detail`

### 输入参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | 必填 | 推文 URL（`https://x.com/{handle}/status/{id}`），支持 `x.com` 和 `twitter.com`，Zod schema 用正则校验格式 |
| `count` | `number` | `20` | 最多返回的回复数量 |
| `debug` | `boolean` | `false` | 是否包含诊断信息 |
| `dumpRaw` | `string?` | — | 原始 GraphQL 响应落盘目录 |

### 输出

标准 `FeedResult`——与 `twitter_feed` 完全相同的结构：

```typescript
{
  items: FeedItem[],       // items[0] = 原推, items[1..n] = 回复
  meta: {
    coveredUsers: string[],
    timeRange: { from: string, to: string },
  },
  debug?: { ... },
}
```

- **原推**（`items[0]`）：优先使用 `note_tweet` 获取完整文本，回退到 `legacy.full_text`。
- **回复**（`items[1..n]`）：按 Twitter 相关性排序。通过 `siteMeta.inReplyTo` 字段区分——回复有此字段，原推没有。
- **过滤**：广告推文和推荐推文（`tweetdetailrelatedtweets-*` entries）会被丢弃。

## Workflow：`getTweetDetail`

```
getTweetDetail(primitives, { url, count, debug, dumpRaw })
│
├─ 1. interceptRequest(/TweetDetail/)
├─ 2. ensureTweetDetail(primitives, collector, { url })
│     ├─ navigate(url)
│     ├─ 检查登录态（URL 是否被重定向到 /login）
│     ├─ waitUntil(collector.length > 0, 3000)
│     └─ fallback: 无数据时 reload 同一 URL；reload 后仍无数据则
│        继续进入 collectData（滚动可能触发 GraphQL）
├─ 3. if (回复数 < count && hasCursor) → collectData(滚动加载)
│     （已验证：滚动确实触发增量 TweetDetail GraphQL 请求）
├─ 4. 组装 FeedResult
│     ├─ items[0] = 原推
│     ├─ items[1..n] = 回复（已过滤广告）
│     └─ meta, debug
└─ 5. cleanup()
```

### Feed vs TweetDetail 对比

| 阶段 | Feed (`getFeed`) | TweetDetail (`getTweetDetail`) | 差异 |
|------|-----------------|-------------------------------|------|
| **拦截 pattern** | `/\/i\/api\/graphql\/.*\/Home.*Timeline/` | `/\/i\/api\/graphql\/.*\/TweetDetail/` | 仅 pattern 不同 |
| **导航** | `ensureTimeline()`：导航到 home，切 tab，处理各种边界情况 | `ensureTweetDetail()`：直接 `navigate(url)` | **简化**——不需要 tab 切换 |
| **等首屏数据** | `collector.waitUntil(length > 0, 3000)` | 同 | **复用** |
| **无数据 fallback** | reload home + 重切 tab | reload 同一 URL | **简化** |
| **解析 GraphQL** | `parseGraphQLTimeline()` 从 `home.home_timeline_urt` 提取 | `parseTweetDetail()` 从 `threaded_conversation_with_injections_v2` 提取 | **新写**——但内部调用 `extractFromTweetResult()` |
| **extractFromTweetResult** | 处理 `tweet_results.result` | 同——字段路径已验证完全一致 | **零修改复用** |
| **滚动加载** | `collectData()` | 同（已知低效：到底后会白滚 3 轮 × 2s = 6s，接受此代价以避免改动共享接口） | **复用** |
| **广告过滤** | `!t.isAd` | 同 | **复用** |
| **结果组装** | 所有 items 平铺，无主次之分 | `items[0]` = 原推，`items[1..n]` = 回复 | **新逻辑**——区分原推和回复 |
| **parseTweet** | `RawTweetData → Tweet` | 同 | **零修改复用** |
| **tweetToFeedItem** | `Tweet → FeedItem` | 同 | **零修改复用** |
| **buildFeedMeta** | 聚合 coveredUsers + timeRange | 同 | **复用** |
| **dumpRaw** | 在 interceptRequest handler 里写文件 | 同模式 | **复用** |
| **debug 信息** | `{ tabRequested, graphqlResponseCount, scrollRounds, elapsedMs, ensureTimeline, collectData }` | `{ graphqlResponseCount, scrollRounds, elapsedMs, ensureTweetDetail, collectData }`——没有 `tabRequested` | **子集** |
| **注册方式** | `capabilities.feed`（框架内置 feed slot） | `customWorkflows[]`（插件扩展点） | 入口不同，但 `mutex`/`circuitBreaker`/`errorScreenshot` 全自动；不走 autoIngest |

**汇总**：

| 类别 | 数量 | 具体 |
|------|------|------|
| **零修改复用** | 7 | `extractFromTweetResult`, `parseTweet`, `tweetToFeedItem`, `buildFeedMeta`, `collectData`, `DataCollector`, 广告过滤 |
| **模式复用，参数不同** | 3 | 拦截 pattern、dumpRaw、debug 信息 |
| **简化** | 2 | 导航（去掉 ensureTimeline）、fallback（单页 reload） |
| **新写** | 2 | `parseTweetDetail()`（entry 分类）、结果组装（原推 + 回复分离） |

## 提取器：`parseTweetDetail`

### Entry 分类

基于实际 GraphQL 响应（2026-03-28 抓取自 `/graphql/.*/TweetDetail`）：

| entryId 前缀 | entryType | 含义 | 处理 |
|---|---|---|---|
| `tweet-{id}` | `TimelineTimelineItem` | 原推 | 提取，标记为 anchor |
| `conversationthread-{id}` | `TimelineTimelineModule` | 回复线程，`items[]` 含 1+ 条回复 | 提取所有 items |
| `tweetdetailrelatedtweets-{id}` | `TimelineTimelineModule` | Twitter 推荐的相关推文 | **丢弃** |
| `cursor-bottom-{id}` | `TimelineTimelineCursor` | 分页游标 | 记录，用于判断是否有更多回复 |

### 提取路径

```
原推:
  entry.content.itemContent.tweet_results.result
  → extractFromTweetResult()

回复（module 内）:
  entry.content.items[i].item.itemContent.tweet_results.result
  → extractFromTweetResult()    // 同一个函数
```

### 返回类型

```typescript
interface TweetDetailParsed {
  anchor: RawTweetData | null;      // 原推（最多 1 条，增量响应中为 null）
  replies: RawTweetData[];          // 回复（从 module 展开为平铺列表）
  hasCursor: boolean;               // 是否有更多回复可加载
}
```

### interceptRequest handler 与 DataCollector 的协作

handler 内部调用 `parseTweetDetail()` 做完整分类，只将 **replies** push 到 collector。anchor 单独保存在闭包变量中（首次响应时赋值，增量响应中忽略）。

这样 `collector.length` 精确等于已收集的回复数，`collectData` 的 `count` 判断直接可用。

### 增量响应结构

经实测验证（131 回复的推文，滚动触发分页）：

- **首屏响应**：包含 `tweet-*`（原推）+ `conversationthread-*`（回复）+ `cursor-bottom`
- **增量响应**：**不包含原推**，只有新的 `conversationthread-*` + cursors
- instruction 类型：首屏有 `TimelineClearCache` + `TimelineAddEntries` + `TimelineTerminateTimeline`；增量只有 `TimelineAddEntries`

`parseTweetDetail` 需要容忍 `anchor` 缺失——增量响应中返回 `anchor: null` 即可。

### 与 `parseGraphQLTimeline` 的差异

| | `parseGraphQLTimeline` | `parseTweetDetail` |
|---|---|---|
| 响应根路径 | `data.home.home_timeline_urt.instructions` | `data.threaded_conversation_with_injections_v2.instructions` |
| 返回类型 | `RawTweetData[]`（平铺列表） | `{ anchor, replies, hasCursor }`（有结构） |
| Entry 过滤 | 无过滤，全部提取 | 按 entryId 前缀分类，丢弃推荐推文 |
| Module 处理 | `TimelineAddToModule` 追加到已有 module | `conversationthread-*` module 内 items 全部展开为回复 |

不抽公共函数——两者的响应根路径、返回结构、过滤逻辑都不同，硬抽反而增加复杂度。共享点只有 `extractFromTweetResult()`，这已经是复用的了。

## 存储策略

**不存储**——查看讨论是临时性的消费行为，不应污染本地 DB。

注册 `customWorkflows` 时不设 `autoIngest`，结果仅返回给调用方。如未来需要持久化，应在框架层扩展 opt-in autoIngest 能力，而不是在 workflow 内部手动调用 ingest。

## 插件注册

通过 `customWorkflows[]` 注册（不走 `capabilities.feed`）：

```typescript
customWorkflows: [{
  name: 'tweet_detail',
  description: 'Get a tweet with its replies',
  params: TweetDetailParamsSchema,
  execute: (primitives, params) => getTweetDetail(primitives, params),
  expose: ['mcp', 'cli'],
}]
```

**框架自动提供**（零额外代码）：
- MCP 工具：`twitter_tweet_detail`
- CLI 命令：`site-use twitter tweet_detail`
- Params Zod 校验
- Mutex 串行化
- CircuitBreaker 熔断
- 错误时自动截图
- 错误提示（Error hints）

**不需要的**（Feed 专属功能）：
- autoIngest（不存储，纯查看工具）
- fetchTimestamp 记录
- Smart cache / localQuery
- Tab variant 逻辑

## GraphQL 响应 Schema 参考

抓取时间：2026-03-28，来源：`https://x.com/shawn_pana/status/2037688071144317428`。

### 响应根路径

```
data.threaded_conversation_with_injections_v2.instructions[]
```

观察到的 instruction 类型：
- `TimelineClearCache`——无 entries
- `TimelineAddEntries`——包含所有 entries（推文、回复、游标）
- `TimelineTerminateTimeline`（x2）——标记两个方向的数据终止

### 推文对象（`tweet_results.result`）

原推和回复的结构完全一致。字段路径已验证与 HomeTimeline 推文相同——`extractFromTweetResult()` 无需修改即可处理。

```
__typename: "Tweet"
rest_id: string                              // 推文 ID

core.user_results.result                     // 作者信息
  .__typename: "User"
  .rest_id: string                           // 用户 ID
  .id: string                                // Base64 编码的全局 ID
  .is_blue_verified: boolean
  .core
    .created_at: string                      // 如 "Thu Apr 10 21:26:16 +0000 2025"
    .name: string                            // 显示名
    .screen_name: string                     // Handle（不含 @）
  .avatar
    .image_url: string                       // 头像 URL
  .legacy
    .description: string                     // 个人简介
    .followers_count: number
    .friends_count: number                   // 关注数
    .statuses_count: number                  // 推文数
    .favourites_count: number                // 点赞数
    .media_count: number
    .listed_count: number
    .profile_banner_url: string
    .default_profile: boolean
    .default_profile_image: boolean
    .possibly_sensitive: boolean
    .want_retweets: boolean
  .location.location: string                 // 如 "sf"
  .privacy.protected: boolean
  .verification.verified: boolean
  .relationship_perspectives
    .following: boolean                      // 当前用户是否关注此作者
    .followed_by: boolean
    .blocking: boolean
    .blocked_by: boolean
    .muting: boolean
  .affiliates_highlighted_label              // 机构徽章（可选）
    .label.description: string               // 如 "Browser Use"
    .label.badge.url: string
  .professional                              // 创作者/商业信息（可选）
    .professional_type: string               // 如 "Creator"
    .category[].name: string                 // 如 "Science & Technology"
  .profile_bio.description: string           // 同 legacy.description
  .profile_description_language: string      // 如 "en"
  .profile_image_shape: string               // 如 "Circle"
  .dm_permissions.can_dm: boolean
  .media_permissions.can_media_tag: boolean
  .super_follow_eligible: boolean
  .super_followed_by: boolean
  .super_following: boolean

legacy                                       // 推文内容
  .full_text: string                         // 可能在 ~280 字符处截断
  .created_at: string                        // 如 "Sat Mar 28 00:27:49 +0000 2026"
  .conversation_id_str: string               // 线程根推文 ID
  .lang: string                              // 如 "en"
  .display_text_range: [number, number]
  .id_str: string                            // 同 rest_id
  .user_id_str: string
  .is_quote_status: boolean
  .quoted_status_id_str: string              // 仅引用推文有
  .quoted_status_permalink                   // 仅引用推文有
    .url: string
    .expanded: string
    .display: string
  .in_reply_to_status_id_str: string         // 仅回复有
  .in_reply_to_screen_name: string           // 仅回复有
  .possibly_sensitive: boolean
  .possibly_sensitive_editable: boolean

  // 互动指标
  .favorite_count: number                    // 点赞数
  .retweet_count: number
  .reply_count: number
  .bookmark_count: number
  .quote_count: number
  .favorited: boolean                        // 当前用户状态（不存储）
  .bookmarked: boolean                       // 当前用户状态（不存储）
  .retweeted: boolean                        // 当前用户状态（不存储）

  // 实体
  .entities
    .urls[]: { url, expanded_url, display_url, indices }
    .user_mentions[]: { screen_name, name, id_str, indices }
    .hashtags[]: { text, indices }
    .media[]: { ... }                        // 简略版
    .symbols[]: { ... }
    .timestamps[]: { ... }
  .extended_entities
    .media[]                                 // 完整媒体信息
      .type: "photo" | "video" | "animated_gif"
      .media_url_https: string               // 图片 URL / 视频缩略图
      .original_info: { width, height, focus_rects }
      .sizes: { large, medium, small, thumb } // 每项: { w, h, resize }
      .video_info                            // 仅 video/animated_gif
        .duration_millis: number
        .aspect_ratio: [number, number]
        .variants[]
          .bitrate: number                   // HLS (.m3u8) 时为 undefined
          .content_type: string              // "video/mp4" 或 "application/x-mpegURL"
          .url: string
      .ext_media_availability.status: string // "Available"
      .allow_download_status.allow_download: boolean
      .additional_media_info.monetizable: boolean

note_tweet                                   // 长推文完整文本（可选，仅超过 280 字符的推文有）
  .is_expandable: boolean
  .note_tweet_results.result
    .id: string
    .text: string                            // 完整未截断文本
    .entity_set                              // 同 legacy.entities 结构
      .hashtags, .symbols, .timestamps, .urls, .user_mentions
    .richtext.richtext_tags: []              // 富文本格式（通常为空）

quoted_status_result                         // 引用推文（可选）
  .result: <Tweet 对象>                      // 同一递归结构

views
  .count: string                             // 浏览数（字符串，需要 parseInt）
  .state: string                             // 如 "EnabledWithCount"

edit_control
  .edit_tweet_ids: string[]
  .editable_until_msecs: string
  .edits_remaining: string
  .is_edit_eligible: boolean

has_birdwatch_notes: boolean                 // Community Notes 标记
is_translatable: boolean
grok_analysis_button: boolean
grok_annotations.is_image_editable_by_grok: boolean
source: string                               // HTML 标签，如 "<a href=\"...\">Twitter Web App</a>"
```

### Entry 包装结构

**原推**（`TimelineTimelineItem`）：
```
entry.entryId: "tweet-{id}"
entry.sortIndex: string
entry.content
  .entryType: "TimelineTimelineItem"
  .__typename: "TimelineTimelineItem"
  .itemContent
    .__typename: "TimelineTweet"
    .itemType: "TimelineTweet"
    .tweetDisplayType: string
    .tweet_results.result: <Tweet 对象>
```

**回复线程**（`TimelineTimelineModule`）：
```
entry.entryId: "conversationthread-{id}"
entry.sortIndex: string
entry.content
  .entryType: "TimelineTimelineModule"
  .__typename: "TimelineTimelineModule"
  .items[]
    .entryId: "conversationthread-{threadId}-tweet-{tweetId}"
    .item
      .itemContent
        .__typename: "TimelineTweet"
        .itemType: "TimelineTweet"
        .tweetDisplayType: string
        .tweet_results.result: <Tweet 对象>
```

**推荐推文**（`TimelineTimelineModule`）：
```
entry.entryId: "tweetdetailrelatedtweets-{id}"
entry.content
  .entryType: "TimelineTimelineModule"
  .items[]: 同回复线程的 items 结构
```

**分页游标**（`TimelineTimelineCursor`）：
```
entry.entryId: "cursor-bottom-{id}"
entry.content
  .entryType: "TimelineTimelineCursor"
  .cursorType: "Bottom"
  .value: string                              // 不透明游标，用于加载下一页
```

### `TweetResultByRestId` 端点

导航到推文详情页时也会触发。包含与 `TweetDetail` 中 `tweet-*` entry 相同的推文对象，但没有对话上下文。本 workflow 不使用——`TweetDetail` 已经足够。

## 测试策略

### Fixture 数据

从 `tmp/graphql-tweet-detail.json` 整理两份 fixture 到 `__tests__/fixtures/`：
- **首屏响应**：含 `tweet-*`（原推）+ `conversationthread-*`（回复）+ `cursor-bottom`
- **增量响应**：仅 `conversationthread-*` + cursors，无原推

### 单元测试

| 测试目标 | 覆盖点 |
|----------|--------|
| `parseTweetDetail`（首屏） | 正确分离 anchor / replies / hasCursor；丢弃 `tweetdetailrelatedtweets-*`；回复从 module 展开 |
| `parseTweetDetail`（增量） | `anchor: null`；新 replies 正确提取；cursor 更新 |
| `parseTweetDetail`（空响应） | 无 `TimelineAddEntries` instruction 时返回空结果 |
| `ensureTweetDetail` | 导航成功 → 数据到达；无数据 → reload fallback；URL 重定向 → 登录态检查 |

参照 `extractors.test.ts` 和 `workflows.test.ts` 的既有模式：mock primitives、buildSnapshot。

### 集成测试

`getTweetDetail` 端到端：mock `interceptRequest` 在 navigate 后触发 handler，验证完整流程从拦截到 FeedResult 组装。

---

## 修订历史

- 2026-03-28：初始设计
  - 范围：`twitter_tweet_detail` MCP 工具 + CLI 命令
  - 方案：GraphQL 拦截（与 `getFeed` 相同模式）
  - 数据探查：抓取实际 `TweetDetail` 响应，验证 extractor 兼容性
  - 滚动分页验证：确认滚动触发增量 GraphQL 请求，`collectData` 可复用
  - 增量响应不含原推，`parseTweetDetail` 容忍 `anchor: null`
  - 存储：不存储，纯查看工具；避免回复数据污染 DB
  - collector 只接收 replies，anchor 单独存，count 语义精确
  - 登录态：`ensureTweetDetail` 中检查 URL 重定向
  - URL 校验：Zod schema 正则，支持 x.com/twitter.com
  - 拦截 pattern 精确写法：`/\/i\/api\/graphql\/.*\/TweetDetail/`
  - collectData 复用：接受到底后 3 轮 stale timeout（6s）代价
  - 测试策略：fixture（首屏+增量）、parseTweetDetail 单元测试、集成测试
  - 完整 GraphQL schema 参考来自实际抓取
