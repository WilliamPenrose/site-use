# twitter_timeline — 功能手册

> 状态：M1 实现，持续演进中
> 源码：`src/sites/twitter/` (types, extractors, workflows)
> MCP 注册：`src/server.ts`

## 概述

抓取当前登录用户的 Twitter/X 主页时间线，返回结构化推文数据。支持 Following（时间序）和 For You（算法推荐）两种 feed。

---

## 三层数据模型

```
GraphQL 原始数据（Twitter 返回）
  │  parseGraphQLTimeline + extractFromTweetResult
  ▼
RawTweetData（进程内中间表示）
  │  parseTweet
  ▼
Tweet（结构化输出）
  ├──→ MCP 返回（JSON，给 agent 消费）
  └──→ 本地存储（M6，给 search/stats 消费）── 计划中
```

### 第一层：GraphQL 原始数据

Twitter 前端通过 GraphQL 端点 `/i/api/graphql/.*/Home.*Timeline` 获取 timeline 数据。site-use 通过 `interceptRequest` 拦截这些响应。

> 以下 schema 基于 2026-03-23 抓取的实际响应（`tmp/graphql-for-you-0.json`）。
> Twitter 可能随时变更 schema，但核心结构长期稳定。

#### 响应顶层结构

```
{
  data.home.home_timeline_urt: {
    instructions: Instruction[],      // 主数据，见下
    metadata: {
      scribeConfig: { page: "for_you" | ??? }  // For You 已确认；Following feed 的值待抓包验证
    },
    responseObjects: { ... }          // 反馈操作，暂不使用
  }
}
```

#### Instruction → Entry

```
Instruction {
  type: "TimelineAddEntries" | "TimelineAddToModule" | "TimelinePinEntry",
  entries: Entry[]
}

Entry {
  entryId:   string,               // "tweet-{id}" | "cursor-{position}-{id}"
  sortIndex: string,               // 排序用大整数
  content: {
    __typename: "TimelineTimelineItem" | "TimelineTimelineCursor",
    entryType:  同上,
    feedbackInfo: { feedbackKeys: string[] },       // 用户反馈操作 key（"不感兴趣"等），埋点用
    clientEventInfo: { component, element, details }, // 客户端行为追踪 / A/B 实验，埋点用
    itemContent: ItemContent       // 推文或光标
  }
}
```

#### ItemContent — 推文

```
ItemContent (tweet) {
  __typename: "TimelineTweet",
  itemType:   "TimelineTweet",
  tweetDisplayType: "Tweet",
  tweet_results: { result: TweetResult },
  promotedMetadata?: PromotedMetadata   // 非空即广告
}
```

#### TweetResult — 完整推文对象

以下是 `tweet_results.result` 的完整字段。标记 `✅` 为当前已提取，`—` 为未提取。

```
TweetResult {
  __typename:  "Tweet" | "TweetWithVisibilityResults" | "TweetTombstone" | "TweetUnavailable"
  rest_id:     string                    ✅ 备选 tweet ID

  // ── 作者 ──
  core: {
    user_results.result: UserResult      ✅ 见下方 UserResult
  }

  // ── 推文内容与指标 ──
  legacy: {
    id_str:              string          ✅ tweet ID
    full_text:           string          ✅ 原始文本（含 t.co 短链 + HTML 实体）
    created_at:          string          ✅ "Mon Mar 23 04:17:57 +0000 2026"
    display_text_range:  [number, number]  — 显示文本的字符区间

    // 互动指标
    favorite_count:      number          ✅ likes
    retweet_count:       number          ✅
    reply_count:         number          ✅
    bookmark_count:      number          ✅
    quote_count:         number          ✅

    // 状态标记
    lang:                string          — "en", "ja", "zh" 等
    conversation_id_str: string          — 线程追踪
    user_id_str:         string          — 作者 ID（冗余，也在 UserResult 中）
    is_quote_status:     boolean         — 是否引用推文
    possibly_sensitive:  boolean         — 敏感内容标记
    possibly_sensitive_editable: boolean — 敏感标记是否可编辑
    retweeted:           boolean         — 当前用户是否已转推
    favorited:           boolean         — 当前用户是否已点赞
    bookmarked:          boolean         — 当前用户是否已收藏

    // 转推 / 引用推文（嵌套完整 TweetResult）
    retweeted_status_result?: { result: TweetResult }   ✅ 仅检查是否存在
    quoted_status_result?:    { result: TweetResult }   — 引用推文完整数据

    // 实体
    entities: {
      urls:          UrlEntity[],        ✅ 用于 processFullText 展开 t.co
      media?:        MediaEntity[],      ✅ 用于 processFullText 去除媒体短链
      user_mentions: MentionEntity[],    — 提及的用户
      hashtags:      HashtagEntity[],    — 话题标签
      symbols:       SymbolEntity[],     — $CASHTAG
      timestamps:    TimestampEntity[]   — 时间实体（罕见）
    }

    // 媒体（优先使用 extended_entities）
    extended_entities?: {
      media: ExtendedMediaItem[]         ✅ 见下方
    }
  }

  // ── 观看数 ──
  views: {
    count: string,                       ✅ 注意：字符串，需 Number() 转换
    state: "EnabledWithCount" | ...
  }

  // ── 长推文 ──
  note_tweet?: {
    is_expandable: boolean,
    note_tweet_results: {
      result: {
        id:   string,
        text: string,                    — 完整长文本（>280 字符不截断）
        richtext: { richtext_tags: [] },
        entity_set: {                    — 长文本专属实体（与 legacy.entities 独立）
          urls, user_mentions, hashtags, symbols, timestamps
        }
      }
    }
  }

  // ── 编辑历史 ──
  edit_control: {
    edit_tweet_ids:      string[],       — 所有版本的 tweet ID
    editable_until_msecs: string,        — 可编辑截止时间戳
    edits_remaining:     string,         — 剩余可编辑次数
    is_edit_eligible:    boolean         — 是否可编辑
  }

  // ── 其他 ──
  source:               string           — 发推客户端 HTML（如 "Twitter Web App"）
  is_translatable:      boolean          — 是否可翻译
  unmention_data:       {}               — 取消提及信息
  grok_analysis_button: boolean          — Grok 分析按钮
  grok_annotations:     { ... }          — Grok 注释
}
```

#### UserResult — 作者信息

```
UserResult {
  __typename:  "User"
  rest_id:     string                    — 用户数字 ID
  id:          string                    — Base64 编码的全局 ID

  // 核心字段（新 schema）
  core: {
    screen_name: string,                 ✅ @handle
    name:        string,                 ✅ 显示名
    created_at:  string                  — 账号创建时间
  }

  // 详细资料（legacy 命名空间）
  legacy: {
    description:          string,        — 个人简介
    followers_count:      number,        — 粉丝数
    friends_count:        number,        — 关注数
    statuses_count:       number,        — 推文数
    favourites_count:     number,        — 点赞数
    media_count:          number,        — 媒体数
    listed_count:         number,        — 被列入列表数
    fast_followers_count: number,        — 快速关注计数
    normal_followers_count: number,      — 常规粉丝计数
    profile_banner_url:   string,        — 横幅图 URL
    url:                  string,        — 个人主页 t.co 短链
    entities:             {},            — 个人简介中的实体
    pinned_tweet_ids_str: string[],      — 置顶推文 ID
    default_profile:      boolean,
    default_profile_image: boolean,
    has_custom_timelines: boolean,
    is_translator:        boolean,
    possibly_sensitive:   boolean,
    want_retweets:        boolean,
    translator_type:      string,
    profile_interstitial_type: string,
    withheld_in_countries: string[]
  }

  // 账号状态
  is_blue_verified:    boolean,          — 蓝标认证
  avatar:              { image_url },    — 头像 URL
  location:            { ... },          — 位置信息
  professional:        { ... } | null,   — 专业账号信息
  profile_bio:         { ... },          — 结构化简介
  profile_image_shape: string,           — 头像形状
  verification:        { ... },          — 认证详情

  // 关系状态（相对当前登录用户）
  follow_request_sent:        boolean,
  super_follow_eligible:      boolean,
  super_followed_by:          boolean,
  super_following:            boolean,
  relationship_perspectives:  { ... },
  affiliates_highlighted_label: { ... },
  parody_commentary_fan_label: string,
  dm_permissions:             { ... },
  media_permissions:          { ... },
  privacy:                    { ... },
  has_graduated_access:       boolean
}
```

#### ExtendedMediaItem — 媒体

```
ExtendedMediaItem {
  type:            "photo" | "video" | "animated_gif"   ✅
  media_url_https: string                               ✅ 图片 URL / 视频缩略图
  id_str:          string                               — 媒体 ID
  media_key:       string                               — 媒体唯一 key
  url:             string                               — t.co 短链（嵌在 full_text 中）
  display_url:     string                               — 显示用短 URL
  expanded_url:    string                               — 展开后的 x.com 链接
  indices:         [number, number]                      ✅ 在 full_text 中的位置

  original_info: {
    width:       number,                                ✅
    height:      number,                                ✅
    focus_rects: []                                     — 焦点区域
  }

  sizes: {                                              — 预生成的缩放尺寸
    thumb:  { w, h, resize: "crop" },
    small:  { w, h, resize: "fit" },
    medium: { w, h, resize: "fit" },
    large:  { w, h, resize: "fit" }
  }

  // 仅 video / animated_gif
  video_info?: {
    aspect_ratio:    [number, number],                  —
    duration_millis: number,                            ✅ 仅 video
    variants: [{                                        ✅ 取最高码率 mp4
      content_type: "video/mp4" | "application/x-mpegURL",
      bitrate?:     number,                             — 码率（bps），m3u8 无此字段
      url:          string
    }]
  }

  // 可用性与权限
  ext_media_availability: { status: "Available" | ... } — 媒体是否可访问
  allow_download_status:  { allow_download: boolean }   — 是否允许下载
  additional_media_info:  { monetizable: boolean }       — 商业化标记
  media_results:          { result: { ... } }            — 媒体 GQL 对象
}
```

#### 实体类型

```
UrlEntity {
  url:          string,          // t.co 短链
  expanded_url: string,          // 真实 URL
  display_url:  string,          // 截断显示
  indices:      [number, number] // 在 full_text 中的位置
}

MentionEntity {
  screen_name: string,
  name:        string,
  id_str:      string,
  indices:     [number, number]
}

HashtagEntity {
  text:    string,               // 不含 #
  indices: [number, number]
}

SymbolEntity {
  text:    string,               // 不含 $
  indices: [number, number]
}
```

#### PromotedMetadata — 广告标记

```
PromotedMetadata {
  impressionId:     string,
  impressionString: string,
  advertiser_results: { result: UserResult },
  clickTrackingInfo: { ... },
  adMetadataContainer: { ... }
}
```

#### ItemContent — 光标（分页）

```
ItemContent (cursor) {
  __typename: "TimelineTimelineCursor",
  entryType:  "TimelineTimelineCursor",
  cursorType: "Top" | "Bottom",
  value:      string                     // 分页 token
}
```

**已处理的推文类型：**

| `__typename` | 处理 |
|-------------|------|
| `Tweet` | 正常提取 |
| `TweetWithVisibilityResults` | 解包 `.tweet` 后正常提取 |
| `TweetTombstone` | 跳过（已删除/受保护） |
| `TweetUnavailable` | 跳过（不可用/NSFW） |

**已处理的 Timeline 指令：**

| 指令 | 处理 |
|------|------|
| `TimelineAddEntries` | ✅ 已处理 |
| `TimelineAddToModule` | ❌ 未处理（M2：用户媒体页分页） |
| `TimelinePinEntry` | ❌ 未处理（M2：用户主页置顶推文） |

### 第二层：进程内中间表示（RawTweetData）

`extractFromTweetResult` 从 GraphQL 响应中提取，是 GraphQL schema 到应用 schema 的桥梁。

```ts
// src/sites/twitter/types.ts
interface RawTweetData {
  authorHandle: string;
  authorName: string;
  text: string;           // processFullText 已处理：t.co → 真实 URL，去 HTML 实体，去媒体短链
  timestamp: string;      // ISO 8601（从 Twitter 的 created_at 转换）
  url: string;            // https://x.com/{handle}/status/{id}
  likes: number;
  retweets: number;
  replies: number;
  views?: number;
  bookmarks?: number;
  quotes?: number;
  media: RawTweetMedia[];
  isRetweet: boolean;
  isAd: boolean;
}
```

**文本处理（`processFullText`）：**
1. 外部 URL：`t.co` 短链 → `expanded_url`（基于 `entities.urls[].indices` 原地替换）
2. 媒体 URL：删除 `t.co` 短链（媒体已在 `media` 数组中）
3. HTML 实体解码：`&amp;` → `&` 等
4. 按 indices 从后往前替换，保证位置不错位

### 第三层：结构化输出（Tweet）

`parseTweet` 将 RawTweetData 映射为 Tweet，做少量转换（提取 tweet ID、映射媒体类型）。

```ts
// src/sites/twitter/types.ts
interface Tweet {
  id: string;
  author: { handle: string; name: string };
  text: string;
  timestamp: string;
  url: string;
  metrics: {
    likes?: number;
    retweets?: number;
    replies?: number;
    views?: number;
    bookmarks?: number;
    quotes?: number;
  };
  media: TweetMedia[];
  isRetweet: boolean;
  isAd: boolean;
}
```

**这一层是 MCP 返回和本地存储的共同输入。**

---

## MCP 接口

### 输入

```ts
twitter_timeline({
  count: number,          // 1-100, default 20
  feed: 'following' | 'for_you',  // default 'following'
  debug: boolean,         // default false
})
```

### 输出

```ts
interface TimelineResult {
  tweets: Tweet[];
  meta: {
    coveredUsers: string[];     // 出现的作者 handle 列表（去重）
    timeRange: { from: string; to: string };  // 推文时间范围
  };
  debug?: {                     // 仅 debug=true 时返回
    feedRequested: string;
    navAction: string;
    tabAction: string;
    reloadFallback: boolean;
    graphqlResponseCount: number;
    rawBeforeFilter: number;
    elapsedMs: number;
  };
}
```

---

## 本地存储（M6，计划中）

Tweet 通过 `store-adapter.ts` 转换为 `IngestItem` 写入 SQLite。

**字段映射：**

| Tweet 字段 | → IngestItem / 存储 | 说明 |
|-----------|---------------------|------|
| `id` | `items.id` | 主键（与 `site='twitter'` 组成联合主键） |
| `text` | `items.text` + `items_fts` | 全文索引 |
| `author.handle` | `items.author` | 结构化筛选 |
| `timestamp` | `items.timestamp` | 时间筛选 + 时间衰减 |
| `url` | `items.url` | 回溯原文 |
| 整个 Tweet JSON | `items.raw_json` | 零信息损失 |
| `metrics.*` | `twitter_meta` 表 | 6 个指标字段 |
| `isRetweet` | `twitter_meta.is_retweet` | 过滤标记 |
| `isAd` | 不存储 | 广告在提取阶段已过滤 |
| `media` | 不索引 | 媒体 URL 时效短，仅存在 `raw_json` 中 |
| `@mentions`（从 text 正则提取） | `item_mentions` 表 | 关联表 |
| `#hashtags`（从 text 正则提取） | `item_hashtags` 表 | 关联表 |

---

## 待实现字段

以下字段在 GraphQL 响应中存在、有价值，但当前 Tweet 类型中缺失：

| 字段 | GraphQL 来源 | 用途 | 目标 |
|------|-------------|------|------|
| `urls` | `legacy.entities.urls[].expanded_url` | 推文中的外部链接列表（独立字段，非仅嵌在 text 中） | 仅存储 |
| `noteText` | `note_tweet.note_tweet_results.result.text` | 长推文完整文本（>280 字符不截断） | 仅存储 |
| `lang` | `legacy.lang` | 语言过滤 | 仅存储 |
| `conversationId` | `legacy.conversation_id_str` | 线程追踪 | 仅存储 |

---

## 运行机制

```
agent 调用 twitter_timeline(count=20, feed='following')
  │
  ├── ensureState: 导航到 x.com + 切换到 Following tab（幂等）
  │
  ├── interceptRequest: 注册 GraphQL 响应拦截器
  │     └── pattern: /\/i\/api\/graphql\/.*\/Home.*Timeline/
  │     └── 每个匹配的响应 → parseGraphQLTimeline → 追加到 interceptedRaw[]
  │
  ├── collectTweetsFromTimeline: 滚动 + 等待数据积累
  │     ├── 初始等待 2s（页面加载触发的 GraphQL）
  │     ├── 循环：scroll down → wait 1.5s → 检查新数据
  │     └── 停止条件：count 达标 或 连续 3 轮无新数据
  │
  ├── 去重（by tweet URL）+ 过滤广告 + 取前 count 条
  │
  ├── parseTweet: RawTweetData[] → Tweet[]
  │
  ├── buildTimelineMeta: 提取 coveredUsers + timeRange
  │
  ├── store.ingest(tweets)  ← M6 计划：同步写入本地库
  │
  └── 返回 TimelineResult（JSON）
```

---

## 修订记录

- 2026-03-23：从 M2 文档中提炼为独立功能手册
  - 整合三层数据模型：GraphQL → RawTweetData → Tweet
  - 整合 MCP 接口定义
  - 整合本地存储映射（M6）
  - 记录待实现字段：urls, noteText, lang, conversationId
