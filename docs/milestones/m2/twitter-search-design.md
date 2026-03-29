# Twitter Search — 总体设计

## 目标

新增 `site-use twitter search` 命令——前往 Twitter 站内搜索内容、采集结果、自动入库到本地知识库。属于 M2 的 "searchTweets" 能力，在当前插件体系下实现。

## 定位

```
数据采集（远程）:   feed, search     ← 去 Twitter 拿数据回来
数据消费（本地）:   site-use search  ← 查询已存储的内容
```

`twitter search` 是数据采集命令，与 `twitter feed` 平行。不替代现有的全局 `site-use search` 命令。

## 技术调研结论

### API 端点

Twitter 搜索使用与 timeline 完全相同的 GraphQL 基础设施：

| | Feed | Search |
|---|---|---|
| 端点 | `/i/api/graphql/.../HomeTimeline` | `/i/api/graphql/.../SearchTimeline` |
| JSON 入口路径 | `data.home.home_timeline_urt.instructions` | `data.search_by_raw_query.search_timeline.timeline.instructions` |
| instructions 以下结构 | `TimelineAddEntries` → entries | **完全相同** |
| 单条推文结构 | `{ __typename: "Tweet", core, legacy, views }` | **完全相同** |
| 分页机制 | 滚动触发，cursor 分页 | **完全相同** |
| 每页条数 | ~20 | 20 |

**可复用组件**：`processEntries()`、`parseTweet()`、`tweetToFeedItem()`、`feedItemsToIngestItems()` 均无需修改。

**需新写的代码**：`parseGraphQLSearch()`（不同的 JSON 入口路径）、搜索页导航逻辑、`SearchTimeline` URL 正则。

### 请求参数

所有 tab 共享同一个 `SearchTimeline` 端点，通过 `product` 变量区分：

| Tab | URL 参数 | API `product` 值 |
|-----|---------|-----------------|
| Top | (无) | `"Top"` |
| Latest | `f=live` | `"Latest"` |
| People | `f=user` | `"People"` |
| Media | `f=media` | `"Media"` |
| Lists | `f=list` | `"Lists"` |

完整请求变量结构：
```json
{
  "rawQuery": "AI",
  "count": 20,
  "querySource": "typed_query",
  "product": "Top",
  "withGrokTranslatedBio": false
}
```

翻页时增加 `"cursor"` 字段。

### 搜索语法

Twitter 支持丰富的搜索运算符，直接嵌入 query 字符串中（参考：[igorbrigadir/twitter-advanced-search](https://github.com/igorbrigadir/twitter-advanced-search)）：

| 类别 | 运算符 |
|------|-------|
| 用户 | `from:user`, `to:user`, `@user`, `filter:follows`, `filter:verified` |
| 时间 | `since:YYYY-MM-DD`, `until:YYYY-MM-DD`, `within_time:2d` |
| 互动量 | `min_faves:N`, `min_retweets:N`, `min_replies:N` |
| 内容类型 | `filter:media`, `filter:images`, `filter:videos`, `filter:links`, `filter:replies` |
| 布尔逻辑 | `OR`, `-exclude`, `"exact phrase"`, `(grouping)` |
| 语言 | `lang:en` |
| 对话 | `conversation_id:ID`, `quoted_tweet_id:ID` |

这些运算符是 query 字符串的一部分，不是独立 API 参数。CLI 只需一个 `--query` 参数，用户自由组合运算符。

### 数据采集流程

与 feed 相同：
1. 导航前注册 `interceptRequest(SEARCH_TIMELINE_PATTERN)`
2. 导航到 `https://x.com/search?q={query}&src=typed_query[&f={tab}]`
3. 滚动触发分页请求
4. 解析拦截到的响应 → 推文 → FeedItems → 入库

### 响应数据 Schema

#### 顶层结构

```
data
└── search_by_raw_query
    └── search_timeline
        └── timeline
            ├── instructions[]          ← 操作指令数组
            └── responseObjects         ← 附加元数据（可忽略）
```

#### Instructions 类型

**首次加载**（1 条指令）：

```
TimelineAddEntries
├── TimelineTimelineModule    ← 推荐用户模块（1 个，含 ~3 个 TimelineUser）
├── TimelineTimelineItem[]    ← 推文（~19 条）
├── TimelineTimelineCursor    ← Top cursor
└── TimelineTimelineCursor    ← Bottom cursor
```

**翻页加载**（3 条指令）：

```
TimelineAddEntries
└── TimelineTimelineItem[]    ← 推文（20 条，无 cursor、无 module）

TimelineReplaceEntry          ← 更新 Top cursor
TimelineReplaceEntry          ← 更新 Bottom cursor
```

#### 单条推文结构（tweet_results.result）

```typescript
{
  __typename: "Tweet",
  rest_id: string,                    // 推文 ID
  source: string,                     // 发送客户端 HTML
  is_translatable: boolean,
  views: { count: string, state: string },

  core: {
    user_results: {
      result: {
        __typename: "User",
        rest_id: string,              // 用户 ID
        is_blue_verified: boolean,
        core: {
          created_at: string,         // 用户注册时间
          name: string,               // 显示名
          screen_name: string,        // @handle
        },
        legacy: {
          description: string,
          followers_count: number,
          friends_count: number,
          statuses_count: number,
          // ...其他用户属性
        },
        verification: {
          verified: boolean,
          verified_type: string,      // "Business" | ...
        },
        relationship_perspectives: {
          following: boolean,         // 当前用户是否关注
          followed_by: boolean,
          blocking: boolean,
          muting: boolean,
        },
      }
    }
  },

  legacy: {
    id_str: string,
    full_text: string,                // 推文正文
    created_at: string,               // "Tue Mar 24 20:00:13 +0000 2026"
    conversation_id_str: string,
    lang: string,

    // 互动量
    favorite_count: number,           // 点赞
    retweet_count: number,            // 转推
    reply_count: number,              // 回复
    bookmark_count: number,           // 书签
    quote_count: number,              // 引用

    // 当前用户状态
    favorited: boolean,
    bookmarked: boolean,
    retweeted: boolean,

    // 内容标记
    is_quote_status: boolean,
    possibly_sensitive: boolean,

    // 实体
    entities: {
      hashtags: Array<{ text: string, indices: [number, number] }>,
      urls: Array<{ url: string, expanded_url: string, display_url: string, indices: [number, number] }>,
      user_mentions: Array<{ screen_name: string, id_str: string, indices: [number, number] }>,
      media?: Array<{
        type: "photo" | "video" | "animated_gif",
        media_url_https: string,
        original_info: { width: number, height: number },
        video_info?: {
          duration_millis?: number,
          variants: Array<{ bitrate?: number, content_type: string, url: string }>,
        },
      }>,
      symbols: Array<{ text: string }>,       // $TSLA 等
    },
    extended_entities?: { media: Array<...> },  // 完整媒体信息（多图时）
  },

  // 可选字段
  edit_control?: { edits_remaining: string, editable_until_msecs: string },
  grok_analysis_button?: boolean,
  quoted_status_result?: { result: Tweet },     // 被引用的推文（递归结构）
}
```

#### 与 Feed 响应的差异

| 差异点 | Feed (HomeTimeline) | Search (SearchTimeline) |
|--------|-------------------|----------------------|
| JSON 入口 | `data.home.home_timeline_urt.instructions` | `data.search_by_raw_query.search_timeline.timeline.instructions` |
| 首次加载特殊项 | 无 | `TimelineTimelineModule`（推荐用户） |
| 翻页指令 | `TimelineAddEntries` + `TimelineReplaceEntry` | **相同** |
| 单条推文 keys | `__typename, core, legacy, rest_id, views, ...` | **相同** |
| legacy 字段 | `full_text, favorite_count, retweet_count, ...` | **相同** |

结论：从 instructions 层往下结构完全一致，现有 `processEntries()` → `parseTweet()` 解析链可直接复用。

### 原始数据

样本 API 响应（首次加载 + 6 次滚动翻页）保存在 `tmp-search-raw/`，供详细设计时参考。

## CLI 接口

```bash
# 基础搜索
site-use twitter search --query "AI agents"

# 选择 tab
site-use twitter search --query "AI" --tab latest

# 限制数量
site-use twitter search --query "from:elonmusk min_faves:1000" --count 50

# 利用 Twitter 原生运算符做复杂过滤
site-use twitter search --query "AI since:2026-03-01 filter:media lang:en"

# 输出控制（框架 flags，与 feed 一致）
site-use twitter search --query "AI" --fields author,text,url
site-use twitter search --query "AI" --quiet
```

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `--query` | string, 必填 | 搜索词（支持 Twitter 搜索运算符） |
| `--tab` | enum, 默认: `top` | `top` \| `latest` |
| `--count` | number, 默认: 20 | 采集数量 (1-100) |
| `--dump-raw` | 可选目录 | 保存原始 GraphQL 响应 |
| `--debug` | boolean | 包含诊断追踪信息 |

框架 flags（`--fields`, `--quiet`）由 codegen 统一处理，与 feed 一致。

## 架构适配

### 插件注册方式：Custom Workflow

作为 `customWorkflows` 条目注册（和 `tweet_detail` 一样）。无需框架改动。搜索本质上就是"导航到页面、拦截 API、采集推文"的 workflow。未来多站需要时再考虑提升为框架级 capability。

仅暴露为 CLI（`expose: ['cli']`），不注册 MCP tool。

### 入库

搜索结果是标准推文格式，与 feed 完全一致。通过框架现有的 `autoIngest` 机制自动入库，搜索回来的推文可通过 `site-use search` 本地查询。

## 范围

### 本期范围
- `site-use twitter search` 命令（仅 CLI）
- Top 和 Latest 两个 tab（返回推文）
- 支持完整的 Twitter 搜索运算符
- `--dump-raw` 调试支持

### 不在本期范围（未来）
- MCP tool 注册
- People tab（返回用户，不是推文——不同数据类型）
- Media tab（可能有用，但需单独处理）
- Lists tab（返回列表，不是推文）
- 缓存控制（`--local`/`--fetch`）——搜索结果没有天然的新鲜度模型
- 保存的搜索 / 搜索历史
