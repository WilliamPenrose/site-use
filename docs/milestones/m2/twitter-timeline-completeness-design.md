# Twitter Timeline 采集完整性设计

> 状态：设计中
> 日期：2026-03-25
> 关联：`docs/milestones/m2/twitter-timeline.md`（现有功能手册）

## 问题

当前 `parseGraphQLTimeline` 只处理 `entryType === 'TimelineTimelineItem'` 的条目，导致以下数据缺失：

1. **Retweet 内容不完整** — 只提取外壳（截断的 `RT @...` 文本 + 无意义的 metrics），原始推文的完整内容、真实 metrics、media 均丢失
2. **TimelineTimelineModule 整体漏采** — 会话线程（conversationthread）、self-thread 等被跳过
3. **Quote Tweet 被引用推文丢失** — 外层评论能采到，但被引用的原推内容没有提取
4. **Reply 关系缺失** — 文本能采到，但不知道在回复谁
5. **搜索结果只有 JSON** — 缺少人类可读的展示格式

## 设计目标

- 让每条 feed 项回答两个问题：**为什么出现在我的 feed 里**（surface reason）和**实际内容是什么**（content）
- AI 能准确提炼"谁做了什么"（发/转/引/回）+ 社交信号
- 搜索结果同时支持 JSON 和 human-readable 文本格式

## 不做

- 不额外请求 API 获取 reply 的被回复推文内容（GraphQL 响应里没有，成本高）
- 不改变 knowledge store 的表结构（利用现有 `rawJson`、`metrics`、`mentions` 字段）
- 不处理 "Who to follow" 推荐模块（非推文内容）

---

## 一、GraphQL 响应完整类型清单

### Instruction 类型

| type | 含义 | 当前处理 | 改后处理 |
|------|------|---------|---------|
| `TimelineAddEntries` | 主数据加载（首次 + 翻页） | ✅ 遍历 entries | 不变 |
| `TimelineAddToModule` | 向已有 module 追加条目 | ❌ 漏采 | 提取 `moduleItems` 中的推文 |
| `TimelinePinEntry` | 置顶推文 | ❌ 漏采 | 提取 `entry` 中的推文 |

### Entry 类型（`entry.content.entryType`）

| entryType | 含义 | entryId 前缀 | 当前处理 | 改后处理 |
|-----------|------|-------------|---------|---------|
| `TimelineTimelineItem` | 单条内容 | `tweet-` | ✅ | 不变 |
| `TimelineTimelineModule` | 内容组 | `conversationthread-`、`who-to-follow-` 等 | ❌ 跳过 | 遍历 `items[]`，提取推文；跳过非推文 module |
| `TimelineTimelineCursor` | 分页光标 | `cursor-` | ❌ 跳过（正确） | 不变 |

### Module 内条目判断

`TimelineTimelineModule` 的 `items[]` 中每个 item 有 `item.itemContent.__typename`：

| __typename | 处理方式 |
|---|---|
| `TimelineTweet` | 提取推文（同 TimelineTimelineItem 内的逻辑） |
| `TimelineUser` | 跳过（Who to follow 等推荐） |

简化规则：**只提取 `__typename === 'TimelineTweet'` 的 item**，其余跳过。

### Tweet 级别包装（`tweet_results.result.__typename`）

| __typename | 处理方式 | 当前状态 |
|---|---|---|
| `Tweet` | 正常提取 | ✅ 已实现 |
| `TweetWithVisibilityResults` | 解包 `.tweet` | ✅ 已实现 |
| `TweetTombstone` | 跳过 | ✅ 已实现 |
| `TweetUnavailable` | 跳过 | ✅ 已实现 |

### 推文语义类型（内容层面）

| 类型 | GraphQL 信号 | 处理策略 |
|------|-------------|---------|
| 原创推文 | 无特殊标记 | `surfaceReason: 'original'` |
| Retweet | `legacy.retweeted_status_result != null` | 提取内层原始推文为主内容，外层转发者记为 `surfacedBy` |
| Quote Tweet | `legacy.is_quote_status && quoted_status_result` | 外层为主内容，内层记为 `quotedTweet` |
| Reply | `legacy.in_reply_to_status_id_str != null` | 正常提取，附加 `inReplyTo` 关系 |
| Retweet of Quote | retweeted_status_result 内层有 quoted_status_result | 内层作为 quote tweet 处理（递归提取自然覆盖） |

#### surfaceReason 优先级

一条推文可能同时满足多个条件（如 reply + quote）。`surfaceReason` 描述的是**为什么出现在 feed 里**，不是推文的内在属性。优先级：

```
retweet > quote > reply > original
```

- 如果是 retweet，无论内层是什么类型，surfaceReason 都是 `'retweet'`（内层的 quote/reply 特征保留在提取出的推文数据中）
- 如果不是 retweet 但是 quote tweet，surfaceReason 是 `'quote'`（即使同时也是 reply）
- 如果只是 reply，surfaceReason 是 `'reply'`
- 其余为 `'original'`

---

## 二、数据模型变更

### RawTweetData 新增字段

```typescript
interface RawTweetData {
  // ... 现有字段不变 ...

  // 新增：行为上下文
  surfaceReason: 'original' | 'retweet' | 'quote' | 'reply';
  surfacedBy?: string;           // retweet 时的转发者 handle

  // 新增：嵌套内容
  quotedTweet?: RawTweetData;    // quote tweet 的被引用推文

  // 新增：reply 关系（轻量）
  inReplyTo?: {
    handle: string;              // 被回复者 screen_name
    tweetId: string;             // 被回复推文 ID
  };
}
```

### Tweet 对应新增字段

```typescript
interface Tweet {
  // ... 现有字段不变 ...

  surfaceReason: 'original' | 'retweet' | 'quote' | 'reply';
  surfacedBy?: string;
  quotedTweet?: Tweet;
  inReplyTo?: {
    handle: string;
    tweetId: string;
  };
}
```

### 废弃字段

- `isRetweet: boolean` — 被 `surfaceReason === 'retweet'` 替代
- `isAd: boolean` — 广告推文在解析阶段已跳过，不会进入结果

过渡期处理：保留两个字段，`isRetweet` 从 `surfaceReason === 'retweet'` 派生赋值（保证现有测试和消费者不受影响），`isAd` 固定为 `false`。后续版本移除。

### Zod schema 注意事项

`types.ts` 中 `RawTweetDataSchema` 和 `TweetSchema` 是 Zod schema（非纯 interface），类型通过 `z.infer` 派生。新增字段需要：

- `surfaceReason`: `z.enum(['original', 'retweet', 'quote', 'reply'])`
- `surfacedBy`: `z.string().optional()`
- `inReplyTo`: `z.object({ handle: z.string(), tweetId: z.string() }).optional()`
- `quotedTweet`: 递归引用自身，需使用 `z.lazy(() => TweetSchema).optional()` — 这是 Zod 处理递归类型的标准方式

### IngestItem / SearchResultItem

不改表结构。新增字段通过以下现有机制传递：

| 新字段 | 存储方式 |
|--------|---------|
| `surfaceReason` | 存入 `rawJson`（Tweet JSON 包含），搜索时通过 DisplaySchema 解析 |
| `surfacedBy` | 存入 `rawJson` + 作为 `mention` 写入 `item_mentions`（社交信号可搜索） |
| `quotedTweet` | 存入 `rawJson`（嵌套 Tweet 对象） |
| `inReplyTo` | 存入 `rawJson` + `inReplyTo.handle` 作为 `mention` 写入 |

---

## 三、Retweet 提取逻辑

当前行为（有 bug）：

```
GraphQL entry → 提取外壳 tweet
  author: GoogleDeepMind（转发者）
  text: "RT @pushmeet: Our AlphaProof..." （截断）
  likes: 0（无意义）
  isRetweet: true
```

改后行为：

```
GraphQL entry → 检测 retweeted_status_result
  → 提取内层原始推文为主内容
     author: pushmeet（原作者）
     text: 完整文本（优先 note_tweet）
     likes: 663（真实 metrics）
     media: [原推图片]
  → 标记
     surfaceReason: 'retweet'
     surfacedBy: 'GoogleDeepMind'
```

### note_tweet 长推文处理

Twitter 长推文（>280字符）的完整文本在 `note_tweet.note_tweet_results.result.text` 中，而 `legacy.full_text` 只有截断版本。

`note_tweet` 是 tweet result 对象的顶层字段，与 `legacy`、`core` 同级（参见 `debug-tweet.json` 第 536 行）。需要在 `TweetWithVisibilityResults` 解包之后读取。

#### 提取规则

```
1. 检查 core.note_tweet.note_tweet_results.result.text
2. 如果存在 → 使用该文本作为 fullText
   - URL 展开使用 note_tweet.note_tweet_results.result.entity_set.urls（不是 legacy.entities.urls）
   - media 提取仍使用 legacy.extended_entities（note_tweet 没有 media 实体）
   - 不做 media URL 剥离（note_tweet 文本中不含 t.co media 链接）
3. 如果不存在 → 回退到 legacy.full_text + legacy.entities（现有逻辑）
```

**关键点：** `note_tweet.entity_set` 的 URL indices 是基于 note_tweet 文本的，与 `legacy.entities` 的 indices 不同。两者不能混用。当使用 note_tweet 文本时，必须用 note_tweet 的 entity_set 做 URL 展开。

这对 retweet 尤其重要——外壳的 `full_text` 是 `RT @xxx: ...` 截断文本，但内层原推的 `note_tweet` 有完整内容。

### ID 和 URL 使用原始推文的

Retweet 提取后，`id` 和 `url` 使用原始推文的值（不是外壳的），避免同一条原推被不同人转发时产生重复条目。Knowledge store 按 `(site, id)` 去重，这样自然合并。

---

## 四、Quote Tweet 提取逻辑

```
GraphQL entry → 检测 is_quote_status + quoted_status_result
  → 外层为主内容（peter 的评论）
     author: peter
     text: "This is exactly the direction we need"
     surfaceReason: 'quote'
  → 内层记为 quotedTweet
     quotedTweet: {
       author: dimillian
       text: "SwiftUI performance tips..."
       url: ...
       metrics: { likes: 1200, ... }
     }
```

`quotedTweet` 递归使用 `extractFromTweetResult` 提取，复用现有逻辑。

### 边界情况

- **quoted_status_result 为 TweetTombstone / TweetUnavailable**：被引用推文已删除或不可用时，`quotedTweet` 设为 `undefined`（不报错，静默跳过）
- **Retweet of Quote Tweet**：外层是 retweet → 提取 `retweeted_status_result` 内层 → 内层有 `quoted_status_result` → 递归提取 quotedTweet。最终结果 surfaceReason = `'retweet'`，主内容是 quote tweet 的外层，quotedTweet 是被引用推文

---

## 五、TimelineTimelineModule 解析

### 当前代码

```typescript
for (const entry of entries) {
  if (content?.entryType !== 'TimelineTimelineItem') continue;  // Module 被跳过
  // ...
}
```

### 改后逻辑

```typescript
for (const entry of entries) {
  const content = entry.content;

  if (content?.entryType === 'TimelineTimelineItem') {
    // 现有逻辑不变
    extractTweetFromItem(content.itemContent, results);

  } else if (content?.entryType === 'TimelineTimelineModule') {
    // 新增：遍历 module 内的 items
    for (const moduleItem of content.items ?? []) {
      const itemContent = moduleItem?.item?.itemContent;
      if (itemContent?.__typename !== 'TimelineTweet') continue;
      extractTweetFromItem(itemContent, results);
    }
  }
  // TimelineTimelineCursor: 忽略（正确）
}
```

### TimelineAddToModule instruction 处理

```typescript
for (const instruction of instructions) {
  if (instruction.type === 'TimelineAddToModule') {
    // moduleItems 结构：与 module.items 相同
    for (const moduleItem of instruction.moduleItems ?? []) {
      const itemContent = moduleItem?.item?.itemContent;
      if (itemContent?.__typename !== 'TimelineTweet') continue;
      extractTweetFromItem(itemContent, results);
    }
  }
  // TimelineAddEntries: 现有逻辑
  // TimelinePinEntry: 同 TimelineTimelineItem 逻辑
}
```

---

## 六、DisplaySchema 增强

### 新增字段映射

```typescript
export const twitterDisplaySchema: DisplaySchema = {
  // ... 现有字段 ...

  // 新增
  surfaceReason:  { path: 'surfaceReason' },
  surfacedBy:     { path: 'surfacedBy' },
  quotedTweet:    { path: 'quotedTweet' },
  inReplyTo:      { path: 'inReplyTo' },
};
```

### Human-readable 格式化

新增函数 `formatTweetText(item: SearchResultItem): string`，输出示例：

**原创推文：**

```
@karpathy · 2026-03-20 14:09
Training a new model today

♡ 1500  ↻ 83  💬 42  👁 120k
🔗 https://x.com/karpathy/status/123456
```

**Retweet：**

```
@pushmeet · 2026-03-20 14:09
↻ retweeted by GoogleDeepMind

Our AlphaProof paper is in this week's issue of @Nature!
In 2024, @GoogleDeepMind's proof agents AlphaProof & AlphaGeometry
together made a substantial leap in AI...

♡ 663  ↻ 89  💬 17  👁 66k
🔗 https://x.com/pushmeet/status/2034995752963809700
```

**Quote Tweet：**

```
@peter · 2026-03-21 09:30
This is exactly the direction we need

  ┃ @dimillian: SwiftUI performance tips that actually work...
  ┃ ♡ 1.2k  ↻ 230

♡ 45  ↻ 12  💬 3
🔗 https://x.com/peter/status/999888777
```

**Reply：**

```
@peter · 2026-03-21 10:15
↩ reply to @dimillian

Totally agree, structured concurrency is the way to go

♡ 8  ↻ 1  💬 0
🔗 https://x.com/peter/status/555666777
```

### 触发方式

`format` 参数**在 MCP 工具层**处理，不进入 `SearchParams`（存储层只负责查询，不关心展示格式）。

MCP search 工具新增可选参数 `format: 'json' | 'text'`，默认 `json`（向后兼容）。调用 `store.search()` 获取结果后，若 `format === 'text'`，在 MCP handler 中对每个 item 调用 `formatTweetText` 格式化后返回纯文本。

---

## 七、store-adapter 变更

### mentions 提取增强

当前 `extractMentions(text: string)` 只从文本中提取 `@handle`。改后 `tweetsToIngestItems` 中额外将以下字段加入 mentions 数组：

- `surfacedBy`（retweet 的转发者）
- `quotedTweet.author.handle`（被引用推文的作者）
- `inReplyTo.handle`（被回复者）

实现方式：在 `tweetsToIngestItems` 中拼接，不改 `extractMentions` 函数签名。

这样通过 `mention` 搜索可以找到所有社交关系。

### coveredUsers 处理

`buildFeedMeta` 的 `coveredUsers` 当前从 `tweet.author.handle` 去重。Retweet 改后 author 变为原作者，转发者在 `surfacedBy` 中。`coveredUsers` 应同时包含 author 和 surfacedBy，确保 feed 覆盖分析准确反映"我关注的谁给我带来了内容"。

### metrics 提取

Retweet 的 metrics 来自原始推文（内层），不再是外壳的 0 值。无需改 `extractMetrics` 函数——因为上游 `parseTweet` 传入的已经是正确的内层数据。

### surfaceReason 作为 metric

将 `surfaceReason` 存为 `strValue` metric：

```typescript
{ metric: 'surface_reason', strValue: 'retweet' }
```

这样可以通过 metric filter 按类型筛选（如"只看转发"）。

---

## 八、变更范围汇总

| 文件 | 变更 |
|------|------|
| `src/sites/twitter/types.ts` | `RawTweetData` / `Tweet` 新增 `surfaceReason`, `surfacedBy`, `quotedTweet`, `inReplyTo` |
| `src/sites/twitter/workflows.ts` | `getFeed` options 新增 `dumpRaw`，拦截回调内写文件 |
| `src/sites/twitter/extractors.ts` | `parseGraphQLTimeline` 支持 Module/PinEntry；`extractFromTweetResult` 处理 retweet 内层提取、quote tweet、reply 关系、note_tweet |
| `src/sites/twitter/display.ts` | DisplaySchema 新增字段 |
| `src/sites/twitter/store-adapter.ts` | mentions 增强、surfaceReason metric |
| `src/display/resolve.ts` | 不改 |
| `src/storage/types.ts` | 不改 |
| `src/storage/query.ts` | 不改 |
| `src/server.ts` | search MCP 工具新增 `format` 参数，handler 中调用 `formatTweetText` |
| `src/sites/twitter/format.ts` | **新增** — `formatTweetText` 纯函数 |
| `tests/unit/twitter-extractors.test.ts` | 新增 retweet/quote/module/reply 测试 |

---

## 九、测试策略

### 单元测试新增用例

1. **Retweet 内层提取** — 验证 author 是原作者、text 是完整文本、metrics 是原推数据、surfacedBy 是转发者
2. **note_tweet 长推文** — 验证优先使用 note_tweet 文本，且 URL 展开使用 note_tweet 的 entity_set
3. **note_tweet 不存在时回退** — 验证回退到 legacy.full_text + legacy.entities
4. **Quote Tweet** — 验证 quotedTweet 字段包含被引用推文完整数据
5. **Quote Tweet 内层已删除** — 验证 quoted_status_result 为 TweetTombstone 时 quotedTweet 为 undefined
6. **Retweet of Quote Tweet** — 验证递归提取：surfaceReason='retweet'，主内容有 quotedTweet
7. **Reply** — 验证 inReplyTo 字段正确提取
8. **surfaceReason 优先级** — reply + quote 同时存在时，surfaceReason 为 'quote'
9. **TimelineTimelineModule** — 构造 conversationthread module，验证内部推文被提取
10. **Module 过滤** — 构造 who-to-follow module，验证被跳过
11. **TimelineAddToModule instruction** — 验证 moduleItems 被正确处理
12. **TimelinePinEntry instruction** — 验证置顶推文被提取
13. **formatTweetText** — 四种类型各一个 snapshot 测试
14. **store-adapter mentions** — 验证 surfacedBy、quotedTweet.author.handle、inReplyTo.handle 被加入 mentions
15. **coveredUsers** — 验证 buildFeedMeta 包含 surfacedBy handles

### 现有测试

所有现有测试应保持通过——新增字段有默认值（`surfaceReason: 'original'`），`isRetweet` 继续从 surfaceReason 派生赋值。

### 待获取的真实 fixture

`TimelineTimelineModule` 的结构目前基于 Twitter 文档和社区逆向推断，没有真实抓包数据验证。实现前通过 `dumpRaw` 功能（见第十节）抓取 For You tab 的 GraphQL 响应，从中提取包含 conversationthread module 的真实 fixture。Retweet 和 Quote Tweet 的结构已由 `debug-tweet.json` 验证。

---

## 十、GraphQL 响应 dump 功能

### 目的

Twitter 会不定期调整 GraphQL 响应结构。需要一个持久化的探查机制，随时可以抓取原始响应用于验证和调试。这也是本次实现的**第一步**——先拿到真实数据，再写解析逻辑。

### 设计

`getFeed` 的选项新增 `dumpRaw?: string`，值为输出目录路径。开启后，拦截到的每个 GraphQL 响应 body 写入该目录：

```
{dumpRaw}/
  graphql-0.json
  graphql-1.json
  graphql-2.json
  ...
```

文件名按拦截顺序编号。内容是原始 JSON（未解析，直接写入），保留 Twitter 返回的完整结构。

### 实现位置

在 `workflows.ts` 的 GraphQL 拦截回调中：

```typescript
// 在 interceptRequest handler 内
if (opts.dumpRaw) {
  const outPath = path.join(opts.dumpRaw, `graphql-${dumpIndex++}.json`);
  fs.writeFileSync(outPath, body);
}
// 然后继续正常的 parseGraphQLTimeline(body)
```

### MCP 暴露

`twitter_feed` MCP 工具新增可选参数 `dump_raw: string`（目录路径）。不传时行为不变。

### 使用场景

```
# 抓取 For You tab 的原始 GraphQL 数据
twitter_feed --tab for_you --count 50 --dump_raw tmp/graphql-dump

# 然后人工检查
ls tmp/graphql-dump/
# graphql-0.json  graphql-1.json  graphql-2.json  ...
```

### 变更范围

| 文件 | 变更 |
|------|------|
| `src/sites/twitter/workflows.ts` | `getFeed` options 新增 `dumpRaw`，拦截回调内写文件 |
| `src/server.ts` | `twitter_feed` MCP 工具新增 `dump_raw` 参数 |
