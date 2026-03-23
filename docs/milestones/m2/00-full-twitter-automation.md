# M2："完整的 Twitter 自动化"

> 上游：[里程碑总览](../overview.md) — M2
> 状态：**规划中**
> 前置：M1 完成，M3 完成

## 目标

在 M1（读 timeline）的基础上，扩展为完整的 Twitter 数据采集能力。用户可以搜索用户、查看特定用户的推文、管理关注关系。

## 新增能力

### 原语扩展

| 原语 | 说明 |
|------|------|
| `type(uid, text)` | 文本输入，搜索用户时需要 |

### 新增 Workflow（4 个）

| Workflow | 说明 | GraphQL 端点 pattern |
|----------|------|---------------------|
| `getUserTweets(handle, count)` | 采集指定用户的推文 | `/graphql/.+/UserTweets`（含 `UserTweetsAndReplies`） |
| `searchUser(query)` | 搜索 Twitter 用户 | `/graphql/.+/SearchTimeline`（type=People） |
| `searchTweets(query, opts?)` | 搜索推文（全网），结果自动落盘到 M6 本地库 | `/graphql/.+/SearchTimeline`（type=Top/Latest） |
| `followUser(handle)` | 关注指定用户 | 无需拦截，点击操作 |
| `getFollowingList()` | 获取当前账号的关注列表 | `/graphql/.+/Following` |

GraphQL 端点 pattern 参考自 [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) 项目的模块拦截器。

### searchTweets 设计说明

**来源：** M6 场景验证（[03-scenario-validation.md](../m6/03-scenario-validation.md) 场景 4）发现的需求——用户需要"先搜本地、再搜全网"的分层检索，类似微信搜索。

**为什么用 GraphQL 拦截而不是 Twitter API：**
- Twitter API v2 免费 tier 搜索限制严格（10 次/月）
- site-use 已有 GraphQL 拦截基础设施（`interceptRequest`），`SearchTimeline` 端点同时支持搜用户和搜推文，只是 `type` 参数不同
- 与 `searchUser` 共用同一个 GraphQL 端点，实现复用度高

**与 M6 的协作：**
- 搜索结果自动走 M6 的 `store.ingest()` 落盘
- 后续同一查询优先命中本地库，无需重复抓取
- Agent 调用流程：`search(本地)` → 不够 → `searchTweets(全网)` → 结果落盘 → `search(本地)` 拿到合并结果

## 提取器增强

M1 的提取器只处理了 HomeTimeline 场景。M2 扩展到用户主页等场景后，需要补全以下能力：

### Timeline 指令解析补全

M1 仅处理 `TimelineAddEntries`。用户主页场景还会用到：

| 指令 | 场景 | 说明 |
|------|------|------|
| `TimelineAddToModule` | 用户媒体页（profile-grid） | 分页加载时向已有模块追加条目 |
| `TimelinePinEntry` | 用户主页 | 置顶推文，不在常规 entries 中 |

### 推文类型防御

M1 只处理了 `Tweet` 和 `TweetWithVisibilityResults`。需要增加：

| 类型 | 含义 | 处理方式 |
|------|------|----------|
| `TweetTombstone` | 已删除或受保护账号的推文 | 跳过，不报错 |
| `TweetUnavailable` | 不可用推文（可能为 NSFW） | 跳过，不报错 |

当前 `extractFromTweetResult` 因为缺少 `legacy`/`userInfo` 会 `return null` 静默跳过，不会崩溃。但这是意外兜底，不是显式判断——未来如果 Twitter 在这些类型上返回部分 `legacy` 字段，可能产生畸形数据。显式按 `__typename` 跳过更安全。

### 完整推文字段

~~M1 的 `Tweet` 类型缺少以下有用字段：~~

| 字段 | 来源 | 状态 |
|------|------|------|
| `views` | `views.count` | ✅ 已加入 MCP 返回 |
| `bookmarks` | `legacy.bookmark_count` | ✅ 已加入 MCP 返回 |
| `quotes` | `legacy.quote_count` | ✅ 已加入 MCP 返回 |
| `altText` | `ext_alt_text` | ✅ 已从 MCP 返回中移除（检索价值低） |
| `urls` | `legacy.entities.urls[].expanded_url` | 待实现 — 推文中包含的外部链接列表（已展开的真实 URL） |
| `noteText` | `note_tweet.note_tweet_results.result.text` | 待实现（仅本地存储需要，MCP 不返回） |

`noteText`：`legacy.full_text` 超过 280 字符会截断，完整文本在 `note_tweet` 中。MCP 场景（总结提炼）截断版够用；本地存储场景（内容检索）需要完整文本。等存储方案落地时实现。

## 数据类型扩展

### 推文字段全景

GraphQL Timeline 响应中每条推文包含的完整字段，及其在 MCP 返回和本地存储中的取舍：

**核心字段**

| 字段 | GraphQL 来源 | MCP | 存储 | 备注 |
|------|-------------|:---:|:----:|------|
| id | `rest_id` | ✅ | ✅ | 主键/去重 |
| text | `legacy.full_text`（展开 URL、去 HTML 实体） | ✅ | ✅ | MCP 用截断版够了 |
| noteText | `note_tweet.note_tweet_results.result.text` | - | ✅ | 长推文完整文本，存储时优先用 |
| timestamp | `legacy.created_at` → ISO 8601 | ✅ | ✅ | |
| url | 拼接 `x.com/{handle}/status/{id}` | ✅ | ✅ | 回溯原文 |
| urls | `legacy.entities.urls[].expanded_url` | ✅ | ✅ | 推文中的外部链接（M1 已在 text 中展开，但未提取为独立字段） |
| lang | `legacy.lang` | - | ✅ | 语言过滤 |
| conversationId | `legacy.conversation_id_str` | - | ✅ | 线程追踪 |
| isRetweet | `legacy.retweeted_status_result != null` | ✅ | ✅ | |
| isAd | `itemContent.promotedMetadata` | ✅ | - | 广告直接过滤不存 |

**作者**

| 字段 | GraphQL 来源 | MCP | 存储 | 备注 |
|------|-------------|:---:|:----:|------|
| authorHandle | `core.screen_name` | ✅ | ✅ | |
| authorName | `core.name` | ✅ | ✅ | |

**互动指标**

| 字段 | GraphQL 来源 | MCP | 存储 | 备注 |
|------|-------------|:---:|:----:|------|
| likes | `legacy.favorite_count` | ✅ | ✅ | |
| retweets | `legacy.retweet_count` | ✅ | ✅ | |
| replies | `legacy.reply_count` | ✅ | ✅ | |
| views | `views.count`（字符串→数字） | ✅ | ✅ | |
| bookmarks | `legacy.bookmark_count` | ✅ | ✅ | |
| quotes | `legacy.quote_count` | ✅ | ✅ | |
| favorited | `legacy.favorited` | - | - | 个人状态，易变 |
| bookmarked | `legacy.bookmarked` | - | - | 同上 |
| retweeted | `legacy.retweeted` | - | - | 同上 |

**媒体**

| 字段 | GraphQL 来源 | MCP | 存储 | 备注 |
|------|-------------|:---:|:----:|------|
| media[].type | `extended_entities.media[].type` | ✅ | ✅ | photo/video/gif |
| media[].url | photo: `media_url_https`，video: 最高码率 variant | ✅ | ✅ | 下载唯一入口 |
| media[].thumbnailUrl | video 的 `media_url_https` | ✅ | ✅ | 视频预览 |
| media[].width/height | `original_info` | ✅ | ✅ | |
| media[].duration | `video_info.duration_millis` | ✅ | ✅ | 视频时长 |
| media[].altText | `ext_alt_text` | - | - | 检索价值低 |
| media[] 全部 variants | `video_info.variants[]` | - | - | 只取最高码率 |

**用户 profile（嵌在推文中的作者快照）**

| 字段 | GraphQL 来源 | MCP | 存储 | 备注 |
|------|-------------|:---:|:----:|------|
| bio | `legacy.description` | - | - | 快照易过时，独立表独立更新 |
| followers/following count | `legacy.followers_count` 等 | - | - | 同上 |
| avatarUrl | `avatar.image_url` | - | - | 同上 |
| bannerUrl | `legacy.profile_banner_url` | - | - | 同上 |
| isBlueVerified | `is_blue_verified` | - | - | 同上 |
| location | `location.location` | - | - | 同上 |

**其他（均不使用）**

| 字段 | GraphQL 来源 | 理由 |
|------|-------------|------|
| source | `source`（HTML 标签） | 发推客户端，分析价值低 |
| editControl | `edit_control` | 编辑历史 |
| grokAnalysis | `grok_analysis_button` | Grok 入口 |
| isTranslatable | `is_translatable` | |

> 原始 GraphQL 响应样本保存在 `tmp/graphql-for-you-0.json`（2026-03-23 抓取，For You feed，332KB）。

### 完整 User 类型

M1 只有 `TweetAuthor: { handle, name }`。M2 的 `getFollowingList` 和 `searchUser` 需要完整的用户信息：

```
User: {
  id, handle, name, bio, avatarUrl, bannerUrl,
  location, website, birthday, createdAt,
  followersCount, followingCount, tweetCount, likesCount,
  verifiedType, isProtected,
  profileUrl
}
```

字段来源：`/graphql/.+/UserByScreenName` 响应中的 `user.result.legacy` + `user.result.is_blue_verified` 等。

## 排除决策（不做）

| 不做什么 | 理由 |
|----------|------|
| `getTweetDetail` workflow | 推文详情页的对话线程采集，复杂度高、需求不明确 |
| KOL 列表本地缓存 | 属于 caller（Skill）的职责，不在 site-use 层面做 |

## Future Consideration

以下能力有价值但不承诺在 M2 实现，记录以备后续规划：

### 导出与下载

| 能力 | 说明 | 参考 |
|------|------|------|
| CSV / HTML 导出 | 在 JSON 之外提供 CSV（带 BOM）和 HTML（带缩略图）格式 | twitter-web-exporter 的 3 种导出格式 |
| 媒体批量下载 | 原图/最高码率视频打包为 ZIP，支持自定义文件名模板 | twitter-web-exporter 的流式 ZIP + aria2 URL 导出 |

这两个能力适合作为独立工具使用，不一定要集成在 MCP workflow 中。

### 架构优化

| 能力 | 说明 | 参考 |
|------|------|------|
| SortIndex BigInt 排序 | 用 Twitter 的 `sortIndex` 字段做精确排序，替代依赖 API 响应顺序 | twitter-web-exporter 用 BigInt 比较 sortIndex 字符串 |
| Extension 注册式拦截分发 | 每个模块声明 URL pattern + parser，统一注册和分发 | twitter-web-exporter 的 Extension 插件体系 |

当 workflow 数量增多、需要分页合并时再考虑。当前 workflow 数量不多，逐个实现即可。

## 参考来源

- [twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) — 浏览器油猴脚本，通过 XHR Hook 拦截 Twitter GraphQL API，支持 17 种数据类型的导出。本文档中 GraphQL 端点 pattern、Timeline 指令类型、推文类型分类、User 字段定义均参考自该项目。

---

## 修订历史

- 2026-03-23：初始 M2 规划创建
  - 范围：type 原语 + 4 个 workflow + 提取器增强 + User 类型
  - 参考 twitter-web-exporter 补充了 GraphQL 端点 pattern、Timeline 指令、推文类型防御、完整字段
  - 导出/下载、SortIndex、Extension 模式列为 future consideration
- 2026-03-23：新增推文字段全景表
  - 抓取 For You feed 原始 GraphQL 响应（332KB），确认 `note_tweet` 字段存在
  - 明确 MCP 返回 vs 本地存储的字段取舍：MCP 不返回 noteText/lang/conversationId；存储不存 isAd/个人状态/用户 profile
  - 已实现：views/bookmarks/quotes 加入 MCP 返回；altText 从 MCP 返回中移除；TweetTombstone/TweetUnavailable 显式跳过
- 2026-03-23：新增 `searchTweets` workflow
  - 来源：M6 场景验证发现"先搜本地、再搜全网"的分层检索需求
  - 复用 SearchTimeline GraphQL 端点（与 searchUser 同端点，type 不同）
  - 搜索结果自动落盘到 M6 本地库
