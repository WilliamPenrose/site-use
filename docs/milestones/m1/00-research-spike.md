# 前置任务：Twitter 内容提取策略 Research Spike

> 上游文档：[技术架构设计 — 新站点接入决策流程](../../2026-03-17-site-use-design.md)、[M1 里程碑](../overview.md) — 能力 4 前置任务
> 状态：已完成（2026-03-19）

## 目标

验证 Twitter timeline 推文能否通过 `evaluate()`/DOM 解析提取结构化数据，确定 M1 的提取策略。

这是 M1 的**已知风险**——如果验证失败，M1 范围需要扩大（将 `interceptRequest` 原语从 M2 提前到 M1）。

---

## 为什么需要这个 Spike

site-use 的架构将**操作**和**提取**分离：matchers 负责定位可交互元素（用 ARIA 语义匹配），extractors 负责提取内容数据。两者的技术路径可以完全不同。

操作侧已经确定用辅助功能树（ARIA role + name），但提取侧有多种可能路径，且最佳路径取决于 Twitter 的前端实现细节——这些细节无法从文档中得知，必须动手验证。

如果盲目假设 DOM 解析可行就开始编码，最坏情况是发现 DOM 中时间戳只有相对值（"2h ago"），或者 metrics 数据存在于 `aria-label` 属性中而非文本节点，导致返工。提前 2 小时做 spike 可以避免后面数天的返工。

### 对 M1 范围的影响

M1 原计划只实现 6/8 个 Primitives 原语，`interceptRequest` 推迟到 M2。但如果 spike 发现只有 GraphQL 拦截才能可靠提取推文数据，就必须提前实现 `interceptRequest`，M1 的 Primitives 范围从 6 个扩大到 7 个。这是做 spike 的核心理由：**提前发现范围变更，而不是编码到一半才发现**。

---

## 背景

本 spike 是[技术架构设计 — 新站点接入决策流程](../../2026-03-17-site-use-design.md)的首次实例。Twitter 作为第一个站点，同时验证该流程本身的可用性。决策树、站点分类矩阵、research spike 检查清单详见设计文档，此处不重复。

Twitter timeline 页面的内容可能来自多种渠道，对应设计文档中 5 层提取策略栈的前 4 层（第 5 层 LLM 兜底在多站点扩展时按需引入，本 spike 不评估）：

| 策略 | 对应策略栈层 | 原理 | 优点 | 缺点 |
|------|------------|------|------|------|
| **Path A: JS 状态对象** | 第 2 层 | `page.evaluate()` 读 React fiber / `__NEXT_DATA__` / 全局状态 | 结构化数据，最稳定 | 不一定能访问 |
| **Path B: DOM 解析** | 第 3 层 | CSS 选择器定位推文容器，逐字段提取 | 直接，无需拦截 | 对 DOM 改版脆弱 |
| **Path C: 辅助功能树** | 第 3 层 | `takeSnapshot()` 获取 ARIA 节点树，从中提取文本 | 与 Primitives 层天然集成 | 信息量可能不够（缺 metrics、timestamp 等） |
| **Path D: GraphQL 拦截** | 第 1 层 | 拦截 `x.com/i/api/graphql/...` 响应 | JSON 结构化，最丰富 | 需要 `interceptRequest`，M1 原计划不实现 |

M1 期望使用 Path A/B/C 中的一种。如果都不可行，则需要 Path D。

### 为什么优先级是 A > B > C > D

- **Path A（JS 状态对象）最优**：直接读 React 内部状态，数据是结构化的 JSON，不受 DOM 渲染方式影响。小红书自动化项目就是用 `window.__INITIAL_STATE__` 成功提取数据的，Twitter 也用 React，可能有类似的内部状态可访问。
- **Path B（DOM 解析）次优**：Twitter 的 `data-testid` 属性是给测试框架用的，在前端生态中属于半稳定的锚点（改 testid 会破坏他们自己的 E2E 测试），比随机 class name 稳定得多。
- **Path C（辅助功能树）第三选择**：ARIA 节点在操作定位上表现优秀（按钮、链接、输入框），但对内容提取来说信息量可能不足——推文的 metrics（点赞数）、精确时间戳、广告标记等在辅助功能树中不一定有。
- **Path D（GraphQL 拦截）是 fallback**：数据最完整，但需要 `interceptRequest` 原语，会扩大 M1 范围。而且 GraphQL endpoint URL 包含哈希值，比 DOM 的 `data-testid` 更容易因 Twitter 部署而变化。

---

## 验证内容

对每条路径，需要回答：

### 必须提取的字段

| 字段 | 优先级 | 说明 |
|------|--------|------|
| `author.handle` | 必须 | 如 `karpathy` |
| `author.name` | 必须 | 如 `Andrej Karpathy` |
| `text` | 必须 | 完整推文文本 |
| `timestamp` | 必须 | ISO 8601 或至少相对时间 |
| `url` | 必须 | 推文永久链接 |
| `isRetweet` | 必须 | 区分转推 |
| `isAd` | 必须 | 过滤广告 |
| `metrics.likes` | 尽力 | 数字 |
| `metrics.retweets` | 尽力 | 数字 |
| `metrics.replies` | 尽力 | 数字 |

### 每条路径的检查清单

- [ ] 能否访问到数据源？（全局变量存在？DOM 元素存在？ARIA 节点包含文本？）
- [ ] 上述字段各能提取几个？哪些缺失？
- [ ] 提取逻辑的稳定性如何？（依赖的 selector / key / 结构有多脆弱？）
- [ ] 对"加载更多"（无限滚动）场景是否有效？（滚动后新加载的内容能否用同样方式提取？）

---

## 验证方法

### 步骤 1：准备环境

1. 用 site-use 的独立 Chrome profile 打开 `x.com/home`（已登录状态）
2. 打开 DevTools Console

### 步骤 2：逐路径验证

#### Path A — JS 状态对象

在 Console 中尝试：

```javascript
// React fiber（Twitter 用 React）
document.querySelector('article')?.__reactFiber$;
document.querySelector('article')?.__reactProps$;

// 全局状态
window.__NEXT_DATA__;
window.__INITIAL_STATE__;

// React DevTools hook（如果安装了 React DevTools 扩展）
window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers;
```

记录：哪些对象存在？结构是什么？能否从中提取推文数据？

#### Path B — DOM 解析

```javascript
// 推文容器
document.querySelectorAll('article[data-testid="tweet"]');
document.querySelectorAll('article[role="article"]');

// 在一个推文容器内检查子元素
const article = document.querySelector('article[data-testid="tweet"]');
article?.querySelector('[data-testid="User-Name"]');     // 作者
article?.querySelector('[data-testid="tweetText"]');      // 文本
article?.querySelector('time');                           // 时间戳
article?.querySelector('a[href*="/status/"]');            // 链接
article?.querySelector('[data-testid="like"]');           // 点赞数
article?.querySelector('[data-testid="retweet"]');        // 转推数
article?.querySelector('[data-testid="reply"]');          // 回复数
article?.querySelector('[data-testid="socialContext"]');   // 转推标记
article?.querySelector('[data-testid="promotedIndicator"]'); // 广告标记
```

记录：哪些 selector 有效？结构是否稳定？`data-testid` 是否存在？

#### Path C — 辅助功能树

用 DevTools Accessibility 面板（Elements → Accessibility 标签）或 Console：

```javascript
// 通过 CDP 协议获取辅助功能树（需要 DevTools Protocol）
// 或在 DevTools Elements 面板选中 article 元素，查看 Accessibility 面板
```

记录：推文内容是否反映在辅助功能树中？role 和 name 包含哪些信息？

#### Path D — GraphQL 拦截（备选验证）

在 DevTools Network 标签中：
1. 筛选 `graphql`
2. 刷新页面 或 滚动 timeline
3. 检查响应中的数据结构

```javascript
// 检查典型的 GraphQL 响应
// 关注 endpoint 如 /i/api/graphql/.../HomeTimeline
```

记录：GraphQL 响应的结构？包含哪些字段？endpoint 命名模式？

### 步骤 3：滚动测试

在选定的路径上，测试无限滚动：
1. 记录当前推文数量
2. 滚动到底部
3. 等待新内容加载
4. 用同样的提取逻辑获取新内容
5. 确认新加载的推文能正常提取

---

## 决策标准

```
Path A 可行（JS 状态对象能访问 + 字段齐全）
  → 采用 Path A（策略栈第 2 层），M1 范围不变

Path A 不行 + Path B 可行（DOM selector 稳定 + 必须字段齐全）
  → 采用 Path B（策略栈第 3 层），M1 范围不变

Path A/B 都不行 + Path C 可行（ARIA 节点含完整文本 + timestamp 可从别处补充）
  → 采用 Path C（策略栈第 3 层），M1 范围不变

Path A/B/C 都不可行
  → 采用 Path D（策略栈第 1 层，GraphQL 拦截），M1 需要将 interceptRequest 从 M2 提前
  → 需要更新 03-primitives.md（实现 7/8 原语而非 6/8）

注意：策略栈第 5 层（LLM 兜底）不在本 spike 评估范围。Twitter 作为高频站点，
按站点分类矩阵应采用确定性提取策略（详见技术架构设计 — 站点分类矩阵）。
```

---

## 交付物

执行完成后，在本文档补充：

1. **结论**：选择了哪条路径（对应策略栈哪一层）
2. **证据**：每条路径的验证结果（截图或 Console 输出）
3. **提取代码草案**：选定路径的 `page.evaluate()` 表达式
4. **风险评估**：选定路径的脆弱点，以及当它失效时的降级方案
5. **对 M1 范围的影响**：是否需要扩大 Primitives 层的实现范围
6. **策略决策记录**：按[技术架构设计 — research spike 检查清单](../../2026-03-17-site-use-design.md)模板填写：
   ```
   站点：twitter.com (x.com)
   提取策略：[选定路径 + 对应策略栈层]
   操作策略：ARIA 匹配（附 ARIA 支持评估结果）
   反爬等级：[高/中/低]
   特殊注意：[无限滚动、动态加载等]
   ```

---

## 验证结果（2026-03-19）

### Path A — JS 状态对象：❌ 不可行

Console 中逐一检查，全部返回 `undefined`：

- `document.querySelector('article')?.__reactFiber$` → undefined
- `document.querySelector('article')?.__reactProps$` → undefined
- `window.__NEXT_DATA__` → undefined
- `window.__INITIAL_STATE__` → undefined
- `window.__REACT_DEVTOOLS_GLOBAL_HOOK__?.renderers` → undefined

**结论**：Twitter 未暴露任何可访问的 React 内部状态或全局数据对象。Path A 不可行。

### Path B — DOM 解析：✅ 可行（作为降级方案保留）

使用 `data-testid` 选择器提取第一条推文的全部字段：

```javascript
const article = document.querySelector('article[data-testid="tweet"]');
// Results:
{
  container: true,
  userName: "Peter Steinberger @steipete · 3h",  // need regex split for name/handle
  tweetText: "Hear me out...",
  time: "2026-03-18T23:49:31.000Z",              // ISO 8601 precise timestamp
  link: "https://x.com/steipete/status/2034416944074613174",
  like: "1.2K",                                   // need parse "1.2K" → 1200
  retweet: "83",
  reply: "163",
  socialContext: undefined,                        // not a retweet — expected
  promotedIndicator: undefined                     // not an ad — expected
}
```

**字段覆盖**：所有必须字段齐全，尽力字段也全部可用。`data-testid` 属性稳定（Twitter 自身 E2E 测试依赖）。

**需额外处理**：`userName` 需正则拆分 name/handle；metrics 如 "1.2K" 需解析为数字。

### Path C — 辅助功能树：❌ 不可行

```javascript
const article = document.querySelector('article[data-testid="tweet"]');
// Results:
{
  role: "article",
  ariaLabel: null,
  ariaDescribedby: null,
  innerText: "Peter Steinberger \n@steipete\n · \n3h\nHear me out...\n163\n83\n1.2K\n51K"
}
```

**问题**：
- 无结构化分隔，所有字段混在一起靠 `\n` 分割
- 时间戳只有相对值 "3h"，无 ISO 8601 精确时间
- metrics 是纯数字 "163\n83\n1.2K"，无法区分哪个是 reply/retweet/like
- 缺少推文永久链接

**结论**：验证了架构文档的预判——ARIA 树适合操作定位（按钮、链接），但不适合内容提取。

### Path D — GraphQL 拦截：✅ 可行（采用为主力方案）

DevTools Network 面板过滤 `graphql`，发现 `HomeLatestTimeline` 请求：

- **Endpoint**：`/i/api/graphql/.../HomeLatestTimeline`
- **响应结构**：`data.home.home_timeline_urt.instructions[].entries[]`
- **每条推文**：`TimelineTimelineItem` → `itemContent` → `TimelineTweet` → `tweet_results`
- **Entry ID 格式**：`tweet-{snowflake_id}`（如 `tweet-2032707899487576138`）
- **数据丰富度**：完整的结构化 JSON，包含所有需要的字段及更多元数据

---

## 决策结论

### 选择 Path D（GraphQL 拦截，策略栈第 1 层）

虽然 Path B（DOM 解析）技术上可行且所有字段齐全，但 **Path D 是技术上更优的选择**：

1. **API 原始数据 vs 渲染层细节**：GraphQL 返回的是结构化 JSON，字段类型明确，不受 DOM 渲染方式影响。DOM 解析依赖 `data-testid`、`textContent` 格式等渲染层实现细节
2. **策略栈优先级**：设计文档的策略栈定义第 1 层（网络拦截）优于第 3 层（DOM 解析）。当第 1 层可行时，应优先采用
3. **数据质量**：GraphQL 响应包含精确的数值型 metrics（无需解析 "1.2K"）、完整的用户信息、精确时间戳等
4. **降级保障**：Path B 作为降级方案保留——如果 GraphQL endpoint 变化导致拦截失败，可回退到 DOM 解析

### 对 M1 范围的影响

**M1 需要扩大 Primitives 实现范围**：`interceptRequest` 从 M2 提前到 M1。

- Primitives 层从实现 6/8 原语扩大到 **7/8 原语**
- 仅 `type(uid, text)` 保留在 M2（M1 无文本输入需求）
- 需要更新：[03-primitives.md](03-primitives.md)、[里程碑总览](../overview.md)

### 策略决策记录

```
Site: twitter.com (x.com)
Extraction strategy: GraphQL interception (strategy stack layer 1)
  - Primary: intercept /i/api/graphql/.../HomeLatestTimeline response
  - Fallback: DOM parsing via data-testid selectors (strategy stack layer 3)
Operation strategy: ARIA matching (confirmed: role="article" present, buttons/links have accessible names)
Anti-crawl level: Medium (requires login, but no aggressive bot detection observed during spike)
Special notes: Infinite scroll triggers new GraphQL requests (same endpoint), interception naturally captures new data
```

### 风险评估

| Risk | Severity | Mitigation |
|------|----------|------------|
| GraphQL endpoint URL contains hash that may change on Twitter deployments | Medium | Intercept by URL pattern `/i/api/graphql/*/Home*Timeline` rather than exact URL; hash changes are detectable (request fails, trigger fallback) |
| GraphQL response structure changes | Low | Twitter's GraphQL schema is versioned; breaking changes are infrequent |
| `interceptRequest` implementation adds complexity to M1 | Low | Well-scoped primitive; Puppeteer's `page.setRequestInterception()` / `page.on('response')` are mature APIs |
| Fallback to DOM parsing requires maintaining two extraction paths | Low | DOM extraction code is simple; only activate on GraphQL failure |
