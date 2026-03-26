# M9: 诊断 Harness — 环境变化的自动感知与验证

> 日期：2026-03-26
> 状态：设计中
> 前置：M8（多站点插件架构）

## 定位

用 fixture 驱动的全链路验证基础设施。当互联网环境变化时（站点改了 API schema、新增字段、调整数据结构），自动发现断裂点，产出结构化诊断报告。

### 不做什么

- **不自动修复**（A 阶段目标是诊断，修复由人在对话中驱动）
- **不是 CI/CD pipeline**（是开发者工具）
- **不替代现有单元测试**（互补关系，见下方对比）

### 与现有测试的关系

| 维度 | 现有单元测试 | M9 Harness |
|------|-------------|------------|
| 数据来源 | 手工构造 | 真实采集的 fixture |
| 验证范围 | 单层 | 全链路（raw → parse → FeedItem → DB → search → format）|
| 何时跑 | 开发时 `pnpm test` | 三个触发源（手动 / 巡检 / 运行时采集）|
| 失败含义 | 代码有 bug | 环境变了，需要适配 |
| fixture 管理 | 无分区 | golden / captured / quarantine 三区隔离 |

### 演进路线

- **A 阶段（本 M）：诊断** — 发现问题、定位断裂层、产出报告，修复由人驱动
- **B 阶段（未来）：诊断 + 方案** — 在报告基础上附上修复 PR 草案，人 review 后合入
- **C 阶段（未来）：全自主闭环** — 诊断、修复、自我验证、提 PR，人只做最终审批

---

## 数据域

一个 site 下可能有多个功能区域，每个区域的 raw 数据结构、parser、variant 维度都不同：

| site | 数据域 | raw 来源 | parser（各自独立） |
|------|--------|---------|-------------------|
| twitter | timeline | HomeTimeline GraphQL | parseGraphQLTimeline |
| twitter | search | SearchTimeline GraphQL | 待建 |
| twitter | profile | UserTweets GraphQL | 待建 |
| reddit | feed | Reddit API JSON | 待建 |

**关键设计：pipeline 分三段。**

```
Layer 0→1: 数据域特定（parser、transformer、variant 签名、断言集）
Layer 2→4: 通用共享（FeedItem → IngestItem → DB → SearchResultItem）
Layer 5:   site 特定（格式化函数和格式断言，由 site 注册）
```

这意味着：
- 每个数据域有自己的 golden fixture、variant 签名算法和 Layer 0→1 断言
- Layer 2→4（DB round-trip、siteMeta resolve）是真正的通用价值，写一次所有数据域受益
- Layer 5 格式化是 site 级别的（Twitter 和 Reddit 的格式化完全不同），由 site 注册
- 新增数据域需要提供：extractEntries + parseEntry + toFeedItem + variant 签名函数 + golden fixture + Layer 0→1 断言

---

## Harness 描述符

**设计决策：不修改 SitePlugin 接口。** Harness 是开发工具，不是运行时能力，不应该出现在插件契约里。

每个 site 单独导出一个 harness 描述符：

```typescript
// src/sites/twitter/harness.ts
import type { SiteHarnessDescriptor } from '../../harness/types.js';

export const twitterHarness: SiteHarnessDescriptor = {
  domains: {
    timeline: {
      extractEntries: extractTimelineEntries,
      parseEntry: parseTimelineEntry,
      toFeedItem: (parsed) => tweetToFeedItem(parseTweet(parsed)),
      variantSignature: computeTimelineVariantSignature,
      assertions: timelineTagAssertions,
    },
    // search: { ... }  未来加
  },
  storeAdapter: feedItemsToIngestItems,
  displaySchema: twitterDisplaySchema,
  formatFn: formatTweetText,
  formatAssertions: twitterFormatAssertions,
};
```

### 关键设计：拆分 extractEntries 和 parseEntry

现有的 `parseGraphQLTimeline` 实际上做了两件事：
1. 从完整 response body 中**提取 entries**（导航 `instructions → entries → itemContent`）
2. **逐条解析** entry 为结构化数据

将这两步拆开，harness 和运行时采集的需求同时得到满足：

| 函数 | 谁调用 | 输入 | 输出 |
|------|--------|------|------|
| `extractEntries(responseBody)` | 运行时采集钩子 | 完整 GraphQL response | 单条 entry 数组 |
| `parseEntry(rawEntry)` | harness runner | 单条 fixture entry | 解析结果 |
| `toFeedItem(parsed)` | harness runner | 解析结果 | FeedItem |

生产代码不需要改。现有的 `parseGraphQLTimeline` 就是 `extractEntries + map(parseEntry)` 的组合，harness 描述符只是把已有逻辑的两个阶段分别引用。

```typescript
// src/harness/types.ts
interface SiteHarnessDescriptor {
  domains: Record<string, DomainDescriptor>;
  storeAdapter: (items: FeedItem[]) => IngestItem[];
  displaySchema: DisplaySchema;
  formatFn: (item: SearchResultItem) => string;
  formatAssertions: Record<string, AssertionFn[]>;
}

interface DomainDescriptor {
  extractEntries: (responseBody: string) => unknown[];
        // 从完整 response body 提取单条 entries（运行时采集用）
  parseEntry: (rawEntry: unknown) => unknown;
        // 单条 entry → 解析结果（harness runner 用）
  toFeedItem: (parsed: unknown) => FeedItem;
        // 解析结果 → FeedItem
  variantSignature: (rawEntry: unknown) => string;
        // raw entry → variant 签名字符串
  assertions: Record<string, AssertionFn[]>;
        // 数据域特定的标签断言注册表（Layer 0→1 执行）
}
```

**发现机制：** harness runner 通过 `import('{site}/harness.ts')` 动态加载。没有 harness 描述符的 site 不支持 harness 验证，不报错。

---

## Fixture 分区

### 存储位置

**golden 在代码目录（git 跟踪），captured/quarantine 在数据目录（不进 git）。**

```
# golden — 版本控制，团队共享，换机器也能用
src/sites/{site}/__tests__/fixtures/golden/
├── timeline-variants.json
├── search-variants.json     # 未来
└── ...

# captured / quarantine — 本机运行产物，不进 git
~/.site-use/harness/{site}/captured/
└── {domain}-{date}-{id}.json

~/.site-use/harness/{site}/quarantine/
└── {domain}-{date}-{id}.json
```

### 分区规则

- **golden 只读** — 自动化流程永远不写入。只有人工确认后通过 `harness promote` 命令升级
- **captured 是临时区** — 验证通过的自动清理（结构没变 = 没价值），失败的移入 quarantine
- **quarantine 是问题区** — 修复后通过 `harness promote` 升级到 golden，fixture 自然生长

### Golden 完整性保护

**核心风险：** AI agent 修复 harness 失败时，可能走阻力最小的路径 — 修改 golden fixture 或断言让测试通过，而不是修复真正的代码问题。必须通过结构性手段让"改 golden"比"改代码"更难。

**保护措施：**

1. **Golden 文件写权限拦截** — 在 `.claude/settings.json` 的 deny 列表中加入 golden 路径。AI 无法直接编辑 golden 文件，只能通过 `harness promote` CLI 命令操作。promote 只接受 captured/quarantine 中的文件作为输入，不接受任意内容。

2. **断言代码变更审查** — 如果一个 commit 同时修改了被测代码（如 `extractors.ts`）和断言代码（如 `assertions.ts`），这是需要人工审查的黄灯信号。在 CLAUDE.md 中明确规则：修复 harness 失败时，只改被测代码，不改断言和 golden。新增断言是独立的改进行为，不应和 bug 修复混在同一个 commit 中。

3. **Vitest golden 测试加保护注释** — 测试文件顶部加明确警告，说明 golden 的修改流程：
   ```typescript
   /**
    * HARNESS GOLDEN VALIDATION
    *
    * These tests run real captured data through the full pipeline.
    * If a test fails:
    *   → Fix the code (parser, transformer, display schema), NOT the fixtures.
    *   → Golden fixtures are the source of truth for "what the real world looks like".
    *   → Only modify golden via `site-use harness promote` after human review.
    */
   ```

### Golden 升级路径

```
运行时/巡检采集 → captured/
                    ├── 结构无变化 → 自动删除
                    └── 结构有变化 → 跑 pipeline
                                      ├── pipeline 通过 → 留在 captured，等人决定是否 promote
                                      └── pipeline 失败 → 移入 quarantine/
                                                            ├── 人修复代码
                                                            └── harness promote → golden/
```

### Golden 失效处理

跑 golden 也可能失败，有两种不同原因：

| 场景 | 原因 | 正确操作 |
|------|------|---------|
| 环境变了，代码没跟上 | 站点改了 schema，parser 还是旧的 | 修 parser（harness 的核心价值）|
| 代码改了，golden 过时 | 你适配了新 schema，旧 fixture 不再适用 | 从 golden 里删掉过时的 entry |

A 阶段不做自动区分。golden 是 git 里的 JSON 文件，过时的 entry 直接编辑删除即可。未来 B 阶段可以通过 git blame 辅助判断。

### Twitter 现有数据迁移

`tweet-variants.json`（32 个 variant，470KB）重命名为 `timeline-variants.json` 移入 `golden/` 目录，无需格式变更。

---

## 全链路 Pipeline

### 逐层验证

harness 对每条 fixture 按 pipeline 顺序逐层运行，每层检查输出：

```
┌─ 数据域特定（每个数据域各自实现）──────────────────────────┐
│                                                            │
│ Layer 0: raw entry（fixture 输入）                          │
│     ↓ domain.parseEntry()                                  │
│ Layer 1: 解析结果（如 RawTweetData）                        │
│     ↓ domain.toFeedItem()                                  │
│ Layer 2: FeedItem                                          │
│     ✓ 数据域断言（domain.assertions，检查 raw→FeedItem 全程）│
│                                                            │
└────────────────────────────────────────────────────────────┘
                          ↓
┌─ 通用共享（所有数据域复用）────────────────────────────┐
│                                                       │
│ Layer 2: FeedItem（续）                                │
│     ✓ 通用断言：Zod schema、siteMeta 存在              │
│     ↓ storeAdapter()                                  │
│ Layer 3: IngestItem                                   │
│     ✓ 通用断言：rawJson 可 parse、metrics 非空         │
│     ↓ ingest()（:memory: DB）                          │
│ Layer 4a: DB 写入完成                                  │
│     ↓ search()                                        │
│ Layer 4b: SearchResultItem                            │
│     ✓ 通用断言：siteMeta 被正确 resolve                │
│                                                       │
└───────────────────────────────────────────────────────┘
                          ↓
┌─ Site 特定（每个 site 注册格式化函数）────────────────┐
│                                                       │
│ Layer 5: formatFn() → 格式化文本                       │
│     ✓ 格式断言（site.formatAssertions）                │
│                                                       │
└───────────────────────────────────────────────────────┘
```

每个数据域注册 Layer 0→2 的域特定部分，Layer 2→4b 是框架通用验证，Layer 5 由 site 注册。新增数据域不需要重写中下段。

### 断裂定位

- **Layer 0→1 失败** — 数据域的 parser 断了（如 Twitter 改了 GraphQL schema）
- **Layer 2→4 失败** — 框架层断了（如 display schema 路径不匹配，正是今天这个 bug 的模式）
- **Layer 5 失败** — site 的格式化函数断了（如新增的 variant 没有对应的格式化逻辑）

### Variant-Aware 断言

不是所有检查对所有 variant 都适用。harness 根据 `_variant` 标签选择对应的断言集。

#### 断言的三层结构

**通用断言（Layer 2→4，所有 site 所有数据域都跑）：**
- Layer 2: Zod schema 通过、siteMeta 存在
- Layer 3: rawJson 可 parse、metrics 数组非空
- Layer 4: siteMeta 被 resolve、url 格式正确

**数据域断言（Layer 0→1，由数据域的 `assertions` 注册表提供）：**

```typescript
// 例：twitter timeline 的断言注册表
const timelineTagAssertions: Record<string, AssertionFn[]> = {
  'retweet':        [surfacedByNotEmpty],
  'quote':          [quotedTweetExists],
  'media:photo':    [hasPhotoMedia, photoHasDimensions, photoUrlValid],
  'media:video':    [hasVideoMedia, videoHasDuration, videoUrlNotEmpty],
  'has_urls':       [linksArrayNotEmpty, noTcoInLinks, textTcoReplaced],
  'following:true': [followingIsTrue],
  'following:false':[followingIsFalse],
  'note_tweet':     [textLongerThanLegacyLimit],
  'wrapped':        [outputMatchesDirectEquivalent],
  'tombstone':      [layer1ReturnsEmpty],
};
```

**格式断言（Layer 5，由 site 的 `formatAssertions` 注册表提供）：**

```typescript
// 例：twitter 的格式断言
const twitterFormatAssertions: Record<string, AssertionFn[]> = {
  'retweet':  [formatContainsRetweetLine],
  'quote':    [formatContainsQuoteBlock],
  '*':        [formatContainsAuthor, formatContainsTimestamp, formatContainsMetrics],
};
```

`'*'` 表示对所有非 tombstone variant 都执行。

#### 扩展机制

断言集随经验自然生长。每次修了一个 bug 或发现新的边界情况，就往注册表里加一条。

扩展方式：
1. **加数据域断言** — 在 `domain.assertions` 注册表中追加
2. **加格式断言** — 在 `site.formatAssertions` 注册表中追加
3. **加通用断言** — 在 harness runner 的通用断言列表中追加
4. **加新标签** — 当新 variant 维度出现时（如 `ad` 类型），注册新标签和断言组

每个断言函数签名统一：

```typescript
interface AssertionContext {
  variant: string;                    // 完整 variant 字符串
  layer: number;                      // 当前验证到哪层
  input: unknown;                     // 当前层的输入
  output: unknown;                    // 当前层的输出
  golden?: unknown;                   // golden 中同 variant 的参照输出（可选）
}

type AssertionFn = (ctx: AssertionContext) => AssertionResult;

interface AssertionResult {
  pass: boolean;
  message?: string;                   // 失败时的诊断信息
}
```

新增断言不需要改 harness runner，只需要在注册表里加一行。

#### 断言执行层由注册位置决定

断言注册在三个不同位置，注册位置即执行层，runner 不需要额外标注：

| 注册位置 | 执行层 | 时机 | `AssertionContext` 内容 |
|----------|--------|------|------------------------|
| `domain.assertions` | Layer 2 入口 | toFeedItem 完成后 | input=raw entry, output=FeedItem |
| 通用断言（runner 内置）| Layer 2→4b | 各步完成后 | input/output 为当前步的输入输出 |
| `site.formatAssertions` | Layer 5 | formatFn 之后 | input=SearchResultItem, output=格式化文本 |

`'*'` 标签是通配符，表示"所有非 tombstone variant 都执行"。runner 处理 `'*'` 时先执行通配断言，再执行匹配的标签断言。

例如 `retweet` 标签的断言分散在两处：
- `surfacedByNotEmpty` 注册在 `domain.assertions['retweet']` → toFeedItem 后执行，检查 FeedItem 中 surfacedBy 是否存在
- `formatContainsRetweetLine` 注册在 `site.formatAssertions['retweet']` → formatFn 后执行，检查文本中是否包含转推行

`AssertionContext.layer` 字段由 runner 填入，仅用于诊断报告，断言函数本身不需要关心自己在哪层。

#### Golden 参照值（A 阶段不实现）

`AssertionContext.golden` 标注为可选。A 阶段 runner 不传此字段。

理由：结构比对（structural diff）已经在 raw 层面提供了 golden 对照。逐层的 golden 参照输出需要"把 golden 也跑一遍 pipeline 到相同 layer"，成本高且 A 阶段价值有限。留到 B 阶段，届时 golden 参照输出可辅助自动生成修复方案。

### 内存 DB 隔离

全链路验证中的 DB 操作使用 `:memory:` 内存数据库，不读不写用户的真实数据目录（`~/.site-use/data/knowledge.db`）。验证完毕后数据库自动丢弃。

---

## 三个触发源

### 触发源 1: 手动触发

用户碰到问题后，在终端运行：

```bash
site-use harness run twitter                           # 跑所有数据域的 golden
site-use harness run twitter --domain timeline         # 只跑 timeline 数据域
site-use harness run twitter --captured                # 跑未验证的新数据
site-use harness run twitter --quarantine              # 重跑之前失败的（修复后验证）
```

产出：完整诊断报告（哪些 variant 通过，哪些断了，断在哪层）。

升级 fixture 到 golden：

```bash
site-use harness promote twitter <file>                # captured/quarantine → golden
```

**Promote 机制：**
1. 读取 captured/quarantine 文件（单条 entry，带 `_variant` 字段）
2. 根据**文件名前缀**（`{domain}-{date}-{id}.json`）确定所属数据域，找到对应的 golden 文件（如 `timeline-variants.json`）
3. 在 golden 数组中查找同 `_variant` 的 entry —— 找到则**替换**（schema 更新），没找到则**追加**（新 variant）
4. 写回 golden 文件，删除源文件

### 触发源 2: 定期巡检

定时任务（用户配置 cron 或 Claude Code schedule），做两件事：

1. **采集** — 真实浏览器跑一次 feed collect，在 interceptRequest 阶段逐条提取 variant 签名，和 golden 比对结构。有差异的存入 captured/
2. **验证** — 对 captured/ 中的新数据跑全链路 pipeline。通过的清理，失败的移入 quarantine/

产出：stderr 摘要。如果有 quarantine 新增，提醒用户。

### 触发源 3: 运行时采集

嵌入正常 `feed collect` 流程，完全异步不阻塞主流程：

```
interceptRequest callback:
  主流程：正常 push 到 intercepted 数组（同步，不变）
  harness：异步 captureForHarness(rawBody)
    → domain.extractEntries(rawBody) 拆出单条 entries
    → 逐条调 domain.variantSignature(entry) 算签名
    → 和 golden 结构比对
    → 有差异 → 存 captured/（带 _variant 字段）
    → 无差异 → 丢弃
```

**不在运行时跑全链路验证**，只做轻量的结构比对和存储，避免影响正常使用。

运行结束后，如果有新 captured 数据，stderr 输出提示：

```
[harness] 2 new variants captured. Run `site-use harness run twitter --captured` to validate.
```

### 触发源对比

| | 手动 | 巡检 | 运行时 |
|---|---|---|---|
| 何时 | 碰到问题后 | 定时 | 每次 feed collect |
| 做什么 | 跑全链路 pipeline | 采集 + 跑全链路 | 只做结构比对和存储 |
| 重量 | 重（全验证） | 重（浏览器 + 全验证） | 轻（异步比对） |
| 产出 | 完整诊断报告 | 摘要 + quarantine | captured 文件 + 提示 |
| 碰真实 DB | 否 | 否（验证用内存 DB） | 否（只存 fixture 文件） |

---

## 存储空间控制

每个 GraphQL response 包含几十条 tweet，但 raw 数据体积大（单条 variant ~15KB）。控制策略：

1. **不存重复结构** — 每条 raw entry 通过数据域的 `variantSignature()` 提取签名，只在发现新 variant 或已有 variant 结构变化时才存。命中已知结构的直接跳过
2. **captured 自动清理** — 验证通过（结构无变化）的自动删除。只有失败的或结构有变化的留下
3. **只存单条 entry** — 不存整个 response body，只存结构上有差异的单条 entry

正常运行时 captured/ 和 quarantine/ 几乎不增长，只有环境真的变了才有新数据。

---

## Variant 签名

### 通用约定

每个数据域提供 `variantSignature(rawEntry): string` 函数。签名用于：
1. 判断 captured entry 属于哪个 variant
2. 在 golden 中找同类 variant 做结构比对

签名格式建议用 `|` 分隔的可读标签，沿用现有 `_variant` 字段命名约定。具体维度由数据域自定义。

### 结构比对

同签名的两条 entry 做结构比对时，只比较 **key 的存在性和值类型**，不比较具体值：

```
golden:   { "legacy": { "full_text": "string", "favorite_count": "number" } }
captured: { "legacy": { "full_text": "string", "favorite_count": "number", "new_field": "string" } }
→ diff: + legacy.new_field (string)
```

新增字段不一定是断裂（可能只是站点加了新数据），但缺失字段大概率是断裂。

### 参考实现：Twitter timeline

> 以下是 twitter timeline 数据域的签名算法，作为其他数据域的参考。

从 raw GraphQL entry 中提取以下特征组合为签名：

| 特征 | 取值 | 提取方式 |
|------|------|---------|
| wrapper | `direct` / `wrapped` | `__typename` 是否为 `TweetWithVisibilityResults` |
| type | `original` / `retweet` / `quote` / `reply` | 是否有 `retweeted_status_result` / `quoted_status_result` / `in_reply_to_status_id_str` |
| following | `true` / `false` | `relationship_perspectives.following` |
| media | `none` / `photo` / `video` | `legacy.extended_entities.media[0].type` |
| note_tweet | 有 / 无 | `note_tweet.note_tweet_results` 是否存在 |
| has_urls | 有 / 无 | `legacy.entities.urls` 非空 |
| tombstone | 是 / 否 | `__typename` 为 tombstone 类型 |

签名示例：`direct|original|following:false|media:photo`

---

## 诊断报告格式

```
[HARNESS] Schema drift detected
  Fixture: captured/timeline-2026-03-27-new-entry.json
  Domain: twitter/timeline
  Variant: direct|original|following:true|media:photo

  ✓ Layer 0→1: parseEntry OK (1 item parsed)
  ✓ Layer 1→2: toFeedItem OK (FeedItem valid)
  ✓ Layer 2→3: storeAdapter OK (IngestItem valid)
  ✓ Layer 3→4a: ingest OK (DB write success)
  ✗ Layer 4a→4b: search FAILED
    Error: siteMeta.likes expected number, got undefined

  Structural diff (vs golden "direct|original|following:true|media:photo"):
    + legacy.extended_entities.media[0].sizes         (object, new)
    - legacy.extended_entities.media[0].original_info  (object, missing)

  Raw fixture saved: quarantine/timeline-2026-03-27-new-entry.json
```

报告包含：
- **数据域** — 哪个 site 的哪个数据域
- **断裂层** — 精确到 Layer N→N+1 的哪一步
- **错误信息** — 具体哪个字段、期望什么、实际什么
- **结构 diff** — 和 golden 同类 variant 的 key 级别差异
- **文件路径** — quarantine 中的 raw 数据，可直接用于修复时的 test input

---

## CLI 接口

```bash
# 核心命令
site-use harness run <site>                            # 跑所有数据域的 golden
site-use harness run <site> --domain <domain>          # 只跑指定数据域
site-use harness run <site> --captured                 # 跑 captured/ 中的数据
site-use harness run <site> --quarantine               # 跑 quarantine/（修复后验证）

# fixture 管理
site-use harness promote <site> <file>                 # captured/quarantine → golden
site-use harness status <site>                         # 显示各数据域的 fixture 状态

# 采集
site-use harness capture <site>                        # 手动触发一次采集（浏览器 → captured/）
```

---

## Vitest 集成

Golden 验证同时作为 vitest 测试运行，纳入 `pnpm test`：

```typescript
// tests/integration/harness-golden.test.ts

/**
 * HARNESS GOLDEN VALIDATION
 *
 * These tests run real captured data through the full pipeline.
 * If a test fails:
 *   → Fix the code (parser, transformer, display schema), NOT the fixtures.
 *   → Golden fixtures are the source of truth for "what the real world looks like".
 *   → Only modify golden via `site-use harness promote` after human review.
 */

import { loadHarness, runVariant } from '../../src/harness/runner.js';

const harness = loadHarness('twitter');

for (const [domain, variants] of Object.entries(harness.goldenVariants)) {
  describe(`HARNESS · twitter/${domain} · ${variants.length} variants`, () => {
    beforeAll(() => {
      const tag = `twitter/${domain} · ${variants.length} variants`;
      const line = '═'.repeat(tag.length + 6);
      console.log(`\n  ╔═${line}═╗`);
      console.log(`  ║   HARNESS · ${tag}   ║`);
      console.log(`  ╚═${line}═╝`);
    });

    for (const variant of variants) {
      it(variant._variant, () => {
        const result = runVariant(harness, domain, variant);
        if (!result.pass) {
          throw new Error(`${result.failedLayer}: ${result.message}`);
        }
      });
    }
  });
}
```

**预期输出：**

```
 ✓ tests/unit/storage-query.test.ts (15 tests)
 ✓ tests/unit/local-mode.test.ts (42 tests)
 ✓ tests/integration/harness-golden.test.ts (32 tests)
   ╔══════════════════════════════════════════════╗
   ║   HARNESS · twitter/timeline · 32 variants  ║
   ╚══════════════════════════════════════════════╝
   ✓ direct|original|following:false
   ✓ direct|original|following:false|has_urls
   ✓ direct|retweet|following:true
   ✗ direct|quote|following:false|media:photo
     Layer 4a→4b: siteMeta.quotedTweet undefined
```

每个 variant 是独立的 `it()`，variant 字符串直接做 test name。失败时一眼看出哪个 variant 断在哪层。

**好处：**
- `pnpm test` 自动包含 golden 验证，不需要单独记得跑 `site-use harness run`
- Golden 变了（promote 了新 variant 或删了过时的），测试自动跟着变
- 一旦上线，`feeditem-roundtrip.test.ts` 等手工全链路测试可以逐步退役

**与 harness CLI 的关系：** vitest 集成只跑 golden（代码回归检测）。captured/quarantine 的验证、采集、promote 等操作仍通过 CLI 执行。

---

## 实现边界

### 需要新增的模块

| 模块 | 职责 |
|------|------|
| `src/harness/types.ts` | `SiteHarnessDescriptor`、`DomainDescriptor`、`AssertionFn` 等类型定义 |
| `src/harness/runner.ts` | 全链路 pipeline 执行器，逐层运行 + 逐层断言 |
| `src/harness/structural-diff.ts` | key 存在性 + 值类型的结构比对算法 |
| `src/harness/capture.ts` | 运行时采集钩子（异步、fire-and-forget） |
| `src/harness/report.ts` | 诊断报告格式化 |
| `src/cli/harness.ts` | CLI 命令（run / promote / status / capture） |
| `src/sites/twitter/harness.ts` | Twitter 的 harness 描述符（pipeline 注册 + 断言） |

### 需要修改的模块

| 模块 | 变更 |
|------|------|
| `src/cli/workflow.ts` | feed collect 流程中嵌入运行时采集钩子 |

### 不修改的模块

- **SitePlugin 接口** — harness 是开发工具，不是运行时能力
- 存储层（schema / ingest / query）— harness 只是调用方
- MCP server — harness 不暴露为 MCP tool
- 现有测试 — harness 和单元测试互补，不替代
