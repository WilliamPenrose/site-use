# M6 场景验证

> 通过模拟真实使用场景，检验 M6 Phase 1/2 的设计是否完备。
> 每个场景标注：当前设计能否覆盖、依赖哪些接口、是否存在缺口。

---

## 场景 1：每日简报 + 下午增量更新

**角色：** OpenClaw 自动化 agent

**流程：**

```
08:00  agent 定时触发
       ├── twitter_timeline()          → 抓取 timeline，推文自动落盘
       ├── search --since 24h --json   → 拿到过去 24h 的推文
       └── LLM 生成简报 → 发送给用户

15:00  用户想看最新动态
       ├── search --since 08:00 --json → 先查本地缓存（毫秒级返回）
       ├── stats --json                → timeRange.to = 08:12 → 判断数据已过时
       ├── twitter_timeline()          → 再次抓取，新推文落盘，旧推文 dedup 跳过
       │   └── IngestResult: { inserted: 8, duplicates: 22, timeRange: { from: "10:30", to: "14:55" } }
       ├── search --since 08:00 --json → 拿到包含增量的完整结果
       └── LLM 生成增量简报
```

**依赖接口：** `twitter_timeline`, `search --since`, `stats`, `IngestResult.timeRange`

**覆盖情况：** ✅ Phase 1 完全覆盖

**已知限制：**
- Twitter timeline 无法指定"只给 8 点以后的"，每次抓取都包含部分旧推文（dedup 代价低）
- 如果 8 小时内推文量很大，单次 timeline 抓取可能只覆盖最近 1-2 小时，中间存在时间 gap
- `IngestResult.timeRange` 让 agent 能发现这个 gap，但填补 gap 需要 timeline 滚动/分页能力（M3）

---

## 场景 2：追踪特定作者的观点变化

**角色：** 研究员用户

**流程：**

```
用户关注 @vitalikbuterin 近一个月对 AI agent 的讨论

search "AI agent" --author vitalikbuterin --since 2026-02-23 --json
→ 返回所有匹配推文，按时间排序
→ agent 或用户阅读后发现观点从怀疑转向积极

stats --json
→ bySite: { twitter: 3200 }, uniqueAuthors: 487
→ 确认数据库有足够覆盖
```

**依赖接口：** `search --author --since`, FTS5 `query`, `stats`

**覆盖情况：** ✅ Phase 1 完全覆盖

**注意：** 前提是过去一个月每天都有 timeline 抓取在跑。如果用户是今天才开始用，历史数据为零。这是"记录者"定位的固有特性——只存看到过的，不回溯抓取。

---

## 场景 3：个人信息流周报——"我关注的人最近在聊什么"

**角色：** OpenClaw agent 做每周总结

**定位澄清：** 这不是全站热门话题发现（那需要 X 全站数据，不是 site-use 能做的）。这是**个人 timeline 视野内的趋势回顾**——"我关注的这些人，过去一周讨论最多的话题是什么、哪些推文互动最高"。

**流程：**

```
search --since 7d --json --limit 200
→ 拿到过去一周 timeline 中的推文

search --hashtag AI --since 7d --json
→ 按标签聚焦特定话题在我 timeline 中的讨论量

search --min-likes 1000 --since 7d --json
→ 在我看到过的推文中，找出高互动的（不代表全站热门）

agent 综合分析 → 生成"你的信息流周报"：
  - 你关注的人本周讨论最多的话题
  - 你 timeline 中互动最高的推文
  - 出现频率上升的 hashtag
```

**依赖接口：** `search --hashtag`, `search --min-likes`, `--since`

**覆盖情况：** ✅ Phase 1 完全覆盖

**固有边界：** 结论仅反映用户个人 timeline 的样本，不代表 X 全站趋势。数据量取决于抓取频率和 timeline 覆盖范围。这是"忠实记录者"定位的自然结果。

---

## 场景 4：分层搜索——"先搜我看过的，再搜全网"

**角色：** 用户想找"关于 AI 自主决策的讨论"

**类比：** 微信搜索——优先匹配聊天记录和联系人，其次搜全网文章。

**理想流程：**

```
search "AI autonomous decision"
  │
  ├── 第一层：本地库（M6）
  │     ├── Phase 1: FTS5 关键词匹配（"AI", "autonomous", "decision"）
  │     ├── Phase 2: embedding 向量 KNN（找到 "大模型自主规划" 等语义相近推文）
  │     └── 返回结果 + 命中数量
  │
  ├── agent 判断：本地结果是否足够？
  │     ├── 足够 → 直接使用
  │     └── 不够 → 进入第二层
  │
  └── 第二层：Twitter API Search（新能力，当前不存在）
        ├── 调用 Twitter Search API → 全网搜索
        ├── 结果自动落盘到本地库（复用 M6 ingest）
        └── 与本地结果合并去重后返回
```

**当前覆盖情况：**
- ✅ 第一层本地搜索：Phase 1 关键词 / Phase 2 语义
- ❌ 第二层全网搜索：**需要新增 Twitter API Search 能力**

**发现的新需求：Twitter API Search**

X 网页版搜索体验差、难以自动化。要实现"搜全网"，需要走 Twitter API：
- Twitter API v2 的 `GET /2/tweets/search/recent`（免费 tier 有，但限 10 次/月）
- 或 `GET /2/tweets/search/all`（Academic/Enterprise tier）
- 搜索结果同样走 M6 的 ingest 管线落盘，后续可本地检索

这个能力不属于 M6（M6 是存储层），应作为 Twitter 站点的新 workflow，类似 `twitter_timeline` 的平行能力（如 `twitter_search`）。需要单独评估 API 成本和 tier 限制。

---

## 场景 5：资源提取——"这周大家分享了什么好东西"

**角色：** OpenClaw agent 做每周资源汇总

**动机：** timeline 里经常有人分享论文、GitHub repo、工具、博客文章。手动刷 timeline 最容易漏掉的就是这些链接——看到了但没点开，过几天就找不到了。

**理想流程：**

```
agent 每周一执行：
  search --since 7d --limit 500 --json
  → 拿到本周所有推文

  agent 侧从 text 中提取 URL（t.co 短链需展开）
  → 按域名聚合：github.com 出现 12 次，arxiv.org 出现 8 次…
  → 按互动量排序：被分享最多 / likes 最高的链接
  → 生成"本周资源周报"：
      - 热门 GitHub 项目（3 条推文提到了同一个 repo）
      - 值得读的论文（arxiv 链接 + 推荐语摘要）
      - 工具推荐
```

**依赖接口：** `search --since --limit --json`

**覆盖情况：** ⚠️ 能用但不够好

**走查发现的问题：**

1. **URL 没有结构化提取。** 当前只提取了 `@mentions` 和 `#hashtags` 到关联表，URL 留在 `text` 原文中。M1 的 `processFullText` 已经将 `t.co` 短链展开为真实 URL 写入 `text` 字段，所以 agent 从 `text` 中正则提取到的就是真实链接，**不需要再做短链展开**。但两个麻烦依然存在：
   - 无法用 SQL 直接查"包含链接的推文"或"按域名筛选"
   - 无法做"被分享最多的链接"这种聚合——需要先全量拉取再客户端处理

2. **`raw_json` 里有更完整的 URL 元数据。** `legacy.entities.urls[]` 包含 `expanded_url`（真实链接）、`display_url`（显示文本）。数据没丢，只是没索引。

**决策：是否加 `item_links` 表？**

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 不加表，agent 侧提取 | 零改动，agent 从 `text` 中正则提取即可（已是真实 URL） | 每次都要全量拉取 + 客户端处理，无法按域名筛选 |
| B. 加 `item_links` 关联表 | 可 SQL 聚合、按域名筛选、复用 mentions/hashtags 模式 | schema 多一张表，ingest 多一步提取 |

**建议：Phase 1 先用方案 A（agent 侧提取），观察实际使用频率。如果资源提取成为高频操作，再加 `item_links` 表。** 数据不会丢（`text` 中已有展开 URL，`raw_json` 中有完整元数据），补建索引随时可做。

---

## 场景 6：社交图谱发现——"谁值得关注"

**角色：** OpenClaw agent 做关注推荐

**动机：** 你关注的人经常 retweet 或 @mention 某些你没关注的人。这些"二度连接"往往是高质量的关注候选——被你信任的人反复提及，说明有价值。

**理想流程：**

```
agent 执行：

  第一步：从本地库统计高频被提及用户
    SQL: SELECT handle, COUNT(*) as cnt
         FROM item_mentions
         GROUP BY handle
         ORDER BY cnt DESC
         LIMIT 50
    → 结果：vitalikbuterin(42次), balaborjigid(28次), karpathy(25次)...

  第二步：获取当前关注列表（M2 能力）
    twitter_following_list()
    → 返回已关注的 handle 列表

  第三步：交叉比对
    高频被提及 - 已关注 = 推荐关注
    → "balaborjigid 被你关注的人提及 28 次，但你没有关注 ta"

  第四步：补充上下文
    search --json（从 text 中找包含该 handle 的推文）
    → 展示"你关注的人是在什么语境下提到这个人的"
```

**依赖接口：** `item_mentions` 表聚合、M2 `getFollowingList`、`search`

**覆盖情况：** ⚠️ 数据层够用，查询接口有缺口

**走查发现的问题：**

1. **`search` 接口不支持聚合查询。** 当前 `search` 返回的是推文列表（item-level），没有 `GROUP BY handle` 的聚合能力。第一步的"统计高频被提及用户"无法通过现有 `SearchParams` 表达。

2. **两个解法：**
   - **A. agent 用 `search` 全量拉取后自己聚合** — 可行但效率低（可能要拉几千条推文）
   - **B. `stats` 接口扩展** — 加一个 `topMentions(limit)` 或更通用的聚合查询能力

3. **依赖 M2。** `getFollowingList` 是 M2 的能力，M6 单独无法完成交叉比对。但 M6 的 `item_mentions` 表已经为这个场景打好了数据基础。

**建议：Phase 1 不改接口。** 这个场景的瓶颈在 M2（关注列表），等 M2 落地后再评估是否需要聚合查询接口。数据层（`item_mentions` + 索引）已完全就绪。

---

## 场景 7：话题监控——"有人聊到 MCP 了告诉我"

**角色：** 用户对特定话题保持关注

**动机：** 你特别关注某个话题（比如 MCP 协议进展），不想每次都手动搜。你信任的这些人只要有人提到，你就想知道。不是搜全网，而是"我的圈子里有人聊这个了吗"。

**流程：**

```
用户设置监控（agent 层面的配置，不在 site-use）：
  topic: "MCP protocol"
  check_interval: 每次 timeline 抓取后

每次 twitter_timeline() 完成后，agent 自动执行：
  search "MCP protocol" --since <last_check_time> --json
  │
  ├── 有新结果 → 推送通知给用户
  │     "@anthropics 发了一条关于 MCP 的推文（3 小时前，likes: 2.1K）"
  │
  └── 无新结果 → 静默，不打扰
```

**依赖接口：** `search --query --since --json`

**覆盖情况：** ✅ Phase 1 完全覆盖

**走查确认：**
- `search` 的 `query`（FTS5 关键词）+ `since`（时间过滤）完全满足需求
- Phase 2 的语义搜索会进一步提升命中率（"MCP protocol" 能匹配到 "model context protocol" 等变体）
- 监控逻辑（定时检查、推送通知）是 agent 层的编排，不需要 M6 额外支持
- 唯一需要的是 agent 记住 `last_check_time`，这是 agent 自己的状态管理

**固有边界：** 只能监控进入你 timeline 的内容。如果你关注的人没聊这个话题，就不会触发。要监控全网讨论需要场景 4 的全网搜索能力。

---

## 缺口汇总

| # | 缺口 | 影响场景 | 严重程度 | 建议 |
|---|------|---------|---------|------|
| 1 | timeline 无法指定时间范围抓取 | 场景 1 (gap) | 低 | 非存储层问题，依赖 M3 滚动能力 |
| 2 | 无站点特有排序（likes/views） | 场景 3 | 低 | agent 可在 JSON 结果上自行排序，未来按需加 |
| 3 | **无全网搜索能力** | **场景 4** | **中** | **已纳入 M2：`searchTweets` workflow，复用 SearchTimeline GraphQL 端点，搜索结果复用 M6 ingest 落盘** |
| 4 | URL 未结构化提取 | 场景 5 | 低 | Phase 1 agent 侧提取够用；数据在 `raw_json` 中未丢失，高频使用时再加 `item_links` 表 |
| 5 | `search` 不支持聚合查询 | 场景 6 | 低 | 等 M2 `getFollowingList` 落地后再评估；`item_mentions` 数据基础已就绪 |
| 6 | 指标不更新 | 已知限制 | 低 | Phase 1 已知限制，spec 已预留 `INSERT OR REPLACE` on `twitter_meta` 演进路径 |
| 7 | 无数据过期/清理机制 | 长期运行 | 低 | 明确延迟到需要时设计 |

**结论：7 个场景走查完成。Phase 1 存储设计对核心场景覆盖充分，1 个中等优先级需求（全网搜索）已纳入 M2，其余缺口均为低优先级且有明确演进路径。**

---

## 附录：系统验证点

> 以下不是用户场景，而是实现时需要确保的内部正确性。对应测试用例见 [01-storage-and-search.md — 测试策略](01-storage-and-search.md#测试策略)。

| 验证点 | 关注什么 | 保障机制 |
|--------|---------|---------|
| 多次抓取去重 | 同一推文不重复存储，`stats.totalItems` 反映真实数量 | `(site, id)` 主键 + `INSERT OR IGNORE`；FTS5 通过 `changes()` 守护不出重复行 |
| 跨站数据融合 | 新增站点只加 `xxx_meta` 表，主表和接口不变 | Class Table Inheritance schema |
| CLI 与 MCP Server 并发 | CLI 读不被 MCP 写阻塞 | `PRAGMA journal_mode = WAL` + `busy_timeout = 5000` |
| 空数据库引导 | 无 DB 时给出清晰的 hint，不崩溃 | 错误输出 JSON + `hint` 字段 |
| 指标不更新 | 同一推文重复抓取时 likes 等指标不更新（Phase 1 已知限制） | `INSERT OR IGNORE` 跳过已有记录；未来可升级为 `INSERT OR REPLACE` on `twitter_meta` only |
