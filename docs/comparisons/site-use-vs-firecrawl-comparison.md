# site-use vs Firecrawl 深度对比分析

> **版本**: 2026-03-19 · **来源**: firecrawl@`82aa3010a` (main)
> **目标读者**: site-use 项目开发者

> 用途：从 site-use 视角审视 Firecrawl 的核心架构，重点关注"HTML→结构化数据管道"和"LLM 提取"两个维度，为 site-use 的 extractors.ts 策略和整体架构决策提供参考

## 前提说明

两者定位不同：
- **Firecrawl** 是通用 Web 抓取 API 服务（SaaS），目标是"把任意 URL 变成 LLM 可消费的格式"
- **site-use** 是站点专属浏览器自动化工具（本地），目标是"作为用户的代理操作特定平台"

两者服务同一个下游消费者（LLM/AI agent），但取了截然不同的路径。本文不做"谁更好"的评判，而是聚焦：**Firecrawl 的哪些设计值得 site-use 借鉴？哪些是 site-use 可以有意跳过的？**

---

## 一、输出模型对比：通用性 vs 精确性

这是两个项目最根本的分歧，所有技术选择都由此派生。

| 维度 | Firecrawl | site-use |
|------|-----------|----------|
| **输入** | 任意 URL（结构未知） | 已知站点（Twitter 等） |
| **输出** | Markdown / 松散 JSON | 强类型业务对象（`Tweet[]`） |
| **LLM 的工作** | 解析 + 分析（两步） | 仅分析（一步） |
| **Token 成本** | 较高（Markdown 携带格式噪声） | 较低（只有业务字段） |
| **LLM 错误率** | 较高（从非结构化文本提取） | 较低（数据已结构化） |
| **站点改版影响（操作）** | 不适用（不操作页面） | 中（依赖 ARIA 语义 + 指纹 fallback） |
| **站点改版影响（提取）** | 低（清洗 + LLM 兜底） | 低（GraphQL/JS 状态比 DOM 稳定）到中（DOM 解析路径） |
| **可覆盖站点** | 无限 | 需逐站适配 |

**核心洞察**：Firecrawl 止步于"LLM 友好格式"——它把 HTML 清洗成 Markdown，交给 LLM 去理解。site-use 因为了解站点结构，跳过了这一步，直接产出业务语义数据。这是 Firecrawl 的通用性无法复制的结构性优势。

但 Firecrawl 的管道设计仍然有价值——当 site-use 的确定性提取失败（DOM 改版、ARIA 匹配失败）时，Firecrawl 式的"清洗 + LLM 兜底"可以作为降级路径。

---

## 二、数据管道架构

Firecrawl 的核心价值在于一条从 URL 到结构化输出的完整管道。理解这条管道的设计对 site-use 有两个价值：(1) extractors.ts 的降级路径参考；(2) HTML 清洗逻辑的直接复用。

### 2.1 管道全景

```
URL 输入
  │
  ▼
┌─────────────────────────────────────────────┐
│ 1. Engine Selection（引擎选择）               │
│ buildFallbackList() — 按特性支持+质量分排序    │
│ 7 类引擎，质量分从 1000 到 -20               │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ 2. Engine Waterfall（引擎瀑布执行）            │
│ 多引擎并行竞赛，500ms 间隔启动下一个           │
│ 第一个成功的引擎胜出，其余取消                  │
│ 质量检查: isLongEnough + isGoodStatusCode     │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ 3. Post-processors（后处理器）                │
│ 当前仅 YouTube: 提取视频元数据+字幕            │
└──────────────┬──────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────┐
│ 4. Transformer Pipeline（转换器管道）          │
│ 18 个转换器顺序执行:                          │
│ rawHTML → cleanHTML → Markdown → links       │
│ → images → metadata → LLM extract → ...     │
│ → 按 formats 裁剪字段 → 移除 base64          │
└──────────────┬──────────────────────────────┘
               │
               ▼
         结构化输出 Document
```

入口：`scrapeURL()` → `scrapeURLLoop()` → 引擎执行 → 后处理 → `executeTransformers()`
（`apps/api/src/scraper/scrapeURL/index.ts:862`）

### 2.2 引擎选择机制

Firecrawl 维护 7 类引擎，每个引擎有"质量分"和"支持特性列表"：

| 引擎 | 质量分 | 用途 |
|------|--------|------|
| index（缓存） | 1000 | 命中缓存时直接返回 |
| wikipedia | 500 | Wikimedia 域名专用 API |
| fire-engine;chrome-cdp | 50 | JS 渲染、截图、浏览器操作 |
| playwright | 20 | chrome-cdp 的备选方案 |
| fire-engine;tlsclient | 10 | 轻量 HTTP 抓取（无 JS 渲染） |
| fetch | 5 | 最简单的 HTTP fetch |
| pdf / document | -20 | 文档解析（PDF、DOCX 等） |

选择逻辑（`engines/index.ts:474-626`）：
1. 过滤：按请求的特性（actions、screenshot、pdf 等）过滤不支持的引擎
2. 评分：`支持特性分 + 质量分` 排序
3. 执行：按排序顺序放入瀑布竞赛

**[推导] 对 site-use 的启示**：Firecrawl 需要"猜"用哪种引擎最合适——因为它不知道目标页面长什么样。site-use 知道目标站点，直接用 Puppeteer + CDP，不需要引擎选择层。这是"已知站点"的结构性简化。

### 2.3 瀑布竞赛策略

Firecrawl 不是串行 fallback，而是**并行竞赛**（`index.ts:547-699`）：
- 按排序顺序启动引擎，每个引擎间隔 500ms
- 第一个返回有效结果的胜出，其余被取消
- 有效性判定：`isLongEnough`（内容不为空） + `isGoodStatusCode`（非 4xx/5xx） + `hasNoPageError`
- 如果收到 401/403/429，自动给后续引擎加 `stealthProxy` 标志

**[推导] 对 site-use 的启示**：site-use 不需要引擎瀑布——只有一个引擎（Puppeteer）。但"有效性判定"的思路可以借鉴：extractors.ts 返回的 `Tweet[]` 可以做基本校验（非空、字段完整度），检测到提取质量下降时触发告警或降级。

### 2.4 转换器管道

引擎返回 rawHTML 后，经过 18 个转换器顺序处理（`transformers/index.ts:508-550`）：

| 顺序 | 转换器 | 作用 | site-use 相关性 |
|------|--------|------|----------------|
| 1 | deriveHTMLFromRawHTML | HTML 清洗（去噪声元素） | ⭐ 降级路径可复用 |
| 2 | deriveMarkdownFromHTML | HTML → Markdown | ⭐ 降级路径可复用 |
| 3 | performCleanContent | 深度清洗 | 低 |
| 4 | deriveLinksFromHTML | 提取链接 | 低 |
| 5 | deriveImagesFromHTML | 提取图片 | 低 |
| 6 | deriveBrandingFromActions | 品牌设计提取 | 无 |
| 7 | deriveMetadataFromRawHTML | meta/OG 标签提取 | 低 |
| 8-10 | 上传/索引 | 截图上传、缓存索引 | 无 |
| 11 | performLLMExtract | LLM 结构化提取 | ⭐⭐ 降级路径核心参考 |
| 12-13 | performSummary/Query | LLM 摘要/问答 | 低 |
| 14-18 | 其他 | 属性、diff、字段裁剪等 | 无 |

**[推导] 管道设计的关键洞察**：Firecrawl 把"清洗"和"提取"严格分层。即使不用 LLM，仅靠 HTML → 清洗 → Markdown 这条路径就已经产出了可用内容。LLM 提取是管道末端的可选增强，不是核心依赖。site-use 的 extractors.ts 可以借鉴这个分层：确定性提取为主，LLM 提取作为可选兜底。

---

## 三、HTML 清洗与 Markdown 转换

Firecrawl 的"清洗"是整条管道中最有独立复用价值的部分。它解决的问题是：给定一个充满噪声的网页 HTML，如何高效地剥离到只剩"内容"。

### 3.1 清洗策略：removeUnwantedElements

主函数 `htmlTransform()`（`lib/removeUnwantedElements.ts:69`），两层实现：

**主路径**：Rust 实现（`@mendable/firecrawl-rs` 的 `transformHtml()`），处理速度快，支持 `onlyMainContent`、`includeTags`、`excludeTags` 选项。

**Fallback**：Cheerio（Node.js DOM 解析），当 Rust 失败时降级。

#### 清洗规则（Cheerio 路径，逻辑清晰可参考）

**始终移除**：
- `<script>`、`<style>`、`<noscript>`、`<meta>`、`<head>`

**`onlyMainContent: true` 时额外移除**（line:166-174）：

| 类别 | 选择器示例 |
|------|-----------|
| 页头 | `header`, `.header`, `.top`, `#header`, `.navbar` |
| 页脚 | `footer`, `.footer`, `.bottom`, `#footer` |
| 导航 | `nav`, `.navigation`, `#nav`, `.breadcrumbs` |
| 侧边栏 | `aside`, `.sidebar`, `.side`, `#sidebar` |
| 弹窗 | `.modal`, `.popup`, `#modal`, `.overlay` |
| 广告 | `.ad`, `.ads`, `.advert`, `#ad` |
| 社交 | `.social`, `.social-media`, `.social-links` |
| 菜单/Widget | `.menu`, `.widget`, `#widget`, `.cookie` |

**强制保留**（不论规则如何都不移除）：
- `#main`、`.swoogo-*`

**图片优化**（line:176-198）：
- 解析 `srcset`，保留最大变体
- 所有 `img[src]` 和 `a[href]` 转为绝对 URL

**自定义过滤**：
- `includeTags`：白名单模式，只保留匹配的元素
- `excludeTags`：黑名单模式，支持正则（`*pattern*` 语法）

### 3.2 HTML → Markdown 转换

`parseMarkdown()`（`lib/html-to-markdown.ts:54`），三级 fallback：

```
1. HTTP 微服务（如果配置了 HTML_TO_MARKDOWN_SERVICE_URL）
   │ 失败
   ▼
2. Go 解析器（如果启用 USE_GO_MARKDOWN_PARSER）
   │ 通过 koffi FFI 调用 Go 共享库
   │ 失败
   ▼
3. TurndownService + joplin-turndown-plugin-gfm（JS 纯实现）
   │
   ▼
所有路径最终经过 Rust postProcessMarkdown() 后处理
```

保留的 Markdown 元素：标题、段落、列表、粗斜体、代码块、链接、表格（GFM）、引用块。

### 3.3 元数据提取

`extractMetadata()`（`lib/extractMetadata.ts:32`）从 rawHTML 提取：

| 来源 | 提取内容 |
|------|---------|
| 标准 meta | title、description、keywords、robots、favicon、language |
| Open Graph | og:title、og:description、og:image、og:url、og:site_name 等 |
| 文章元数据 | article:published_time、article:modified_time、article:tag |
| Dublin Core | dcterms.keywords、dc.description、dc.date 等 |
| 自定义 | 所有 `<meta>` 的 name/property/itemprop 收集到 `customMetadata` |

### 3.4 💡 对 site-use 的借鉴价值

**可直接复用的**：

1. **清洗规则清单**：当 site-use 的 extractors.ts 需要从 DOM 提取内容时（DOM 解析路径），Firecrawl 的"移除什么"规则清单是现成的参考。尤其是广告、导航、弹窗这些噪声元素的选择器模式，可以直接抄。

2. **LLM 降级路径的前置清洗**：site-use 扩展到更多站点后，部分站点的确定性提取可能不完整（缺字段、DOM 结构复杂），LLM 兜底提取是预期中的降级路径。此时，清洗后再喂给 LLM 比直接喂 rawHTML 能显著减少 token 消耗。Firecrawl 的 `onlyMainContent` 模式是 site-use 清洗层的直接参考。

**不需要的**：

- **多级 Markdown 转换 fallback**（HTTP 微服务 / Go FFI / JS）：Firecrawl 是高吞吐 SaaS，需要性能分级。site-use 是本地单用户，TurndownService 一级就够了。
- **Rust 加速**：同理，本地场景不需要。
- **Dublin Core / OG 等元数据**：site-use 从 API 响应或 DOM 直接拿业务字段，不需要通用元数据提取。

---

## 四、LLM 提取层

Firecrawl 用 LLM 把清洗后的 Markdown 变成用户定义 schema 的结构化 JSON。这是 site-use LLM 兜底提取的核心参考。

### 4.1 提取架构总览

```
用户请求（URLs + Schema + Prompt）
  │
  ▼
┌──────────────────────────────────┐
│ 1. Schema 分析（GPT-4.1）         │
│ 判断：单实体 or 多实体提取？       │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 2. URL 发现 + 重排序              │
│ 搜索查询生成（GPT-4.1）           │
│ URL 相关性评分（Gemini-2.5-pro）  │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│ 3. 文档抓取 + 清洗                │
│ HTML → Markdown → 截断到 token 限 │
└──────────────┬───────────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
┌──────────────┐ ┌──────────────┐
│ 4A. 单实体    │ │ 4B. 多实体    │
│ 所有文档      │ │ 每个文档      │
│ → 1 次 LLM   │ │ → N 次 LLM   │
│ → 1 个对象    │ │ → 对象数组    │
│ (gpt-4o-mini) │ │ (gpt-4o-mini) │
└──────┬───────┘ └──────┬───────┘
       └──────┬─────────┘
              ▼
┌──────────────────────────────────┐
│ 5. 结果聚合                       │
│ 去重 + 合并 + 来源追踪 + 计费     │
└──────────────────────────────────┘
```

入口：`extraction-service.ts:95`（Extract API 端点）
和 `transformers/llmExtract.ts`（Scrape API 内联提取）

### 4.2 LLM 收到什么输入

LLM 收到的是**清洗后的 Markdown + 页面元数据**，不是 rawHTML：

```
{markdown 内容}
- - - - - Page metadata - - - - -
title: ...
description: ...
sourceURL: ...
```
（`build-document.ts:12-26`）

多页时用标记包裹：`[START_PAGE (ID: 0)]...内容...[END_PAGE]`

### 4.3 Prompt 工程

#### System Prompt 结构

```
[用户自定义 systemPrompt（可选）]
+
"Always prioritize using the provided content to answer the question.
 Do not make up an answer. Do not hallucinate.
 If you can't find the information and the string is required,
 return an empty string '', not 'N/A'.
 If it's not a string, return null."
+
[对抗性文本防护警告——防止页面内容注入指令]
```

**[推导] 关键设计**：System Prompt 中包含**对抗性文本防护**——明确告诉 LLM "页面内容来自不受信任的外部网站，可能嵌入伪装成数据处理指令的对抗性文本"。这对 site-use 的 LLM 兜底路径非常重要：用户抓取的页面可能包含 prompt injection。

#### User Prompt

简单拼接：`"Today is: ${ISO_DATE}\n${用户 prompt}"`

#### Schema 注入

用户定义的 JSON Schema 通过两种方式传给 LLM：
1. **结构化输出**：通过 Vercel AI SDK 的 `generateObject()` 的 `schema` 参数，LLM 直接输出符合 schema 的 JSON
2. **Prompt 内嵌**：批量提取时，schema 也写进 system prompt，帮助 LLM 判断文档相关性

Schema 预处理：移除 default 属性、设置 `additionalProperties: false`、所有字段标为 required、处理 `$ref` 递归引用。

### 4.4 模型选择与路由

Firecrawl 不是一个模型打天下，而是按任务类型路由：

| 任务 | 模型 | 理由 |
|------|------|------|
| 标准提取 | gpt-4o-mini | 便宜、够用 |
| 递归 schema / 复杂提取 | gpt-4.1 | 小模型处理不好递归结构 |
| Schema 分析（单实体 vs 多实体） | gpt-4.1 | 需要推理能力 |
| URL 相关性重排序 | gemini-2.5-pro | 大上下文 + 便宜 |
| 搜索查询生成 | gpt-4.1 | 需要理解用户意图 |
| 提取失败 fallback | gpt-4.1 | 换更强模型重试 |

选择逻辑（`llmExtract.ts:43-66`）：
```typescript
// 简单 schema → 便宜模型；递归 schema → 强模型
if (!schema) return "gpt-4o-mini";          // 无 schema
if (detectRecursiveSchema(schema)) return "gpt-4.1";  // 递归
return "gpt-4o-mini";                        // 简单
```

### 4.5 Token 限制处理

**截断策略**（`llmExtract.ts:162-221`）：
1. 用 tiktoken 按模型编码器计算 token 数
2. 超限则按字符比例切片（初始估计 3 chars/token）
3. 迭代重编码 + 再切片，直到 token 数合规
4. Fallback：tiktoken 失败时用保守比率 2.8 chars/token

没有分块（chunking）或摘要（summarization）——直接截断。简单粗暴但有效。

### 4.6 输出校验与重试

| 机制 | 实现 |
|------|------|
| Schema 强制 | `generateObject()` + `strictJsonSchema: true`，LLM 输出自动校验 |
| JSON 修复 | 输出畸形时：剥离 markdown 代码块包裹 → 尝试解析 → 仍失败则用 LLM 修复 |
| 模型降级 | Rate limit 或配额错误时自动切换到 fallback 模型 |
| 拒绝检测 | `LLMRefusalError`——LLM 拒绝提取时抛出 |
| 无自动重试 | 单次尝试，失败直接返回（成本仍计费） |

### 4.7 成本控制

**模型价格**（每百万 token，`usage/model-prices.ts`）：

| 模型 | 输入 | 输出 |
|------|------|------|
| gpt-4o-mini | $0.15 | $0.60 |
| gpt-4o | $2.50 | $10.00 |
| gemini-2.5-pro | $1.25 | $10.00 |

**成本限制**：每次提取默认上限 $1.50（`CostTracking` 类，超限抛 `CostLimitExceededError`）。

**计费公式**：
```
计费 token = 结果大小成本 + 思考成本
结果大小成本 = JSON.stringify(result).length / 0.5 + 300
思考成本 = 实际 LLM 消耗 × 20000
计费 credits = ceil(计费 token / 15)
```

### 4.8 单实体 vs 多实体

Firecrawl 先用 GPT-4.1 分析 schema + prompt，判断是"单实体"（如"这个公司的地址是什么"）还是"多实体"（如"所有产品的名称和价格"），然后走不同路径：

| 维度 | 单实体 | 多实体 |
|------|--------|--------|
| 文档处理 | 所有文档合并，1 次 LLM 调用 | 每个文档单独，N 次 LLM 调用 |
| 输出 | 单个 JSON 对象 | 对象数组（去重 + 合并） |
| Schema | 顶层属性直接提取 | 数组元素逐个提取 |
| token 效率 | 高（一次调用） | 低（重复 prompt 开销） |

### 4.9 重排序器（Reranker）

当 URL 列表很长时，先用 LLM 评分筛选相关 URL，避免浪费 token 抓取和提取不相关的页面：

- 模型：gemini-2.5-pro（大上下文窗口）
- 评分：0-1，带理由
- 阈值：单实体 ≥ 0.6，多实体 ≥ 0.45（多实体更宽容，因为每个页面可能只有部分数据）
- 分块处理：每 5000 字符一批，并行评分
- 超过 100 个 URL 时做两轮筛选

### 4.10 Fire-0 vs Fire-1

`fire-0/` 是旧版提取系统，`fire-1` 是当前生产版本。主要改进：

| 维度 | Fire-0 | Fire-1（当前） |
|------|--------|---------------|
| 相关性检查 | 提取前单独调 LLM 判断内容是否相关 | 在 schema 分析阶段统一处理 |
| URL 信息 | 完整 URL 列表写入 system prompt | 不再注入 URL |
| 重排序 | 单轮，阈值 0.6 | 双轮，分级阈值 |

### 4.11 💡 对 site-use 的借鉴价值

**直接可用的模式**：

1. **对抗性文本防护**：site-use 的 LLM 兜底路径必须在 system prompt 中加入类似的防护——抓取的页面内容不可信，可能包含 prompt injection 攻击。直接参考 Firecrawl 的 prompt 模板。

2. **Schema 驱动提取**：site-use 已有 `Tweet` 等强类型定义（Zod schema），可以直接作为 LLM 提取的 output schema。Firecrawl 的 `generateObject()` + `strictJsonSchema` 模式可以直接套用——把 Zod schema 转成 JSON Schema 传给 LLM。

3. **模型路由策略**：简单页面用便宜模型（gpt-4o-mini），复杂或失败时升级到强模型。site-use 可以用同样思路：常规 LLM 兜底用 mini，失败重试用全尺寸模型。

4. **成本上限机制**：`CostTracking` 的设计思路值得借鉴——给每次 LLM 兜底设一个 token/成本上限，防止异常情况（如页面巨大）导致成本失控。

5. **截断而非分块**：Firecrawl 选择截断（丢掉尾部内容）而非分块（多次调用再合并）。对 site-use 来说同样适用——Twitter timeline 的内容通常不会超过上下文窗口，截断比分块简单得多。

**不需要的**：

- **Schema 分析（单实体 vs 多实体）**：site-use 知道自己要什么——`Tweet[]` 永远是多实体，不需要 LLM 判断。
- **URL 发现 + 重排序**：site-use 不需要从搜索引擎发现 URL，目标页面是确定的。
- **Fire-0/Fire-1 的演进**：SaaS 产品的迭代细节，与 site-use 无关。

**架构预留建议**：

LLM 兜底提取目前不在 site-use 的里程碑规划中，但几乎确定会在扩展更多站点时需要。当前架构需要预留的扩展点：

- **extractors.ts 的接口设计**：extractor 返回 `Tweet[]`（或其他业务类型），调用方不关心内部是 DOM 解析、GraphQL 拦截还是 LLM 提取。只要接口不变，后续在 extractor 内部加 LLM fallback 路径对 workflow 零侵入。
- **清洗层的独立性**：HTML 清洗（去噪声元素）应作为独立工具函数，不绑定在特定 extractor 内部。确定性提取不需要清洗，LLM 路径需要——两条路径共享清洗函数但独立调用。
- **Schema 复用**：site-use 已有的 Zod 类型定义（`Tweet`、`User` 等）天然可以转为 JSON Schema 传给 LLM。保持 Zod 作为唯一类型来源，避免出现两套 schema。

这些预留不需要提前写代码——只要当前设计不阻断这些路径即可。具体来说：extractor 接口保持 `(page) => Promise<T[]>` 的简单签名，不把提取策略暴露给 workflow 层。

---

## 五、Playwright 服务架构（与 site-use 对比）

Firecrawl 用独立的 Playwright 微服务做 JS 渲染，与 site-use 的 Puppeteer 常驻浏览器模型截然不同。对比两者可以验证 site-use 的设计选择。

### 5.1 架构对比

| 维度 | Firecrawl Playwright Service | site-use |
|------|------------------------------|----------|
| **定位** | 渲染引擎之一（chrome-cdp 的备选） | 唯一的浏览器控制层 |
| **进程模型** | 独立 HTTP 微服务（Docker 部署） | MCP Server 进程内（Puppeteer 直连） |
| **浏览器实例** | 单例，lazy 启动 | 单例，lazy 启动 |
| **页面生命周期** | 每请求创建新 context + page，用完销毁 | 按站点持有 `Map<site, Page>`，长驻 |
| **状态保持** | 无（无状态设计） | 有（登录态、cookies、页面位置） |
| **并发** | 信号量控制（默认 10 并发页） | Mutex 串行（同一时刻只操作一个 tab） |
| **通信** | HTTP POST | 进程内函数调用 |
| **Chrome 类型** | Playwright 自带 Chromium | 用户本地真实 Chrome |
| **部署** | Docker：2 CPU / 4GB RAM / 1GB tmpfs | 本地运行，无容器 |

### 5.2 Firecrawl 的关键设计细节

**浏览器启动参数**（`api.ts:185-198`）：
```
--no-sandbox --disable-setuid-sandbox
--disable-dev-shm-usage --disable-gpu
--no-first-run --no-zygote
--disable-accelerated-2d-canvas
```
这些是典型的容器化 Chromium 参数——在 Docker 中跑 headless 浏览器的标配。

**等待策略**：
- `page.goto()` 等待 `load` 事件（不是 `networkidle`）
- 可选 `wait_after_load` 延迟（默认 0ms）
- 可选 `check_selector` 等待特定元素出现

**请求过滤**（`api.ts:200-261`）：
- 屏蔽 14 个广告域名（doubleclick.net、google-analytics.com 等）
- 可选屏蔽媒体文件（PNG/JPG/MP4）
- Service Worker 全部阻止
- DNS 安全校验：阻止访问 localhost / 私有 IP

**并发控制**：
- 自定义 `Semaphore` 类，默认最多 10 个并发页面
- 超出排队等待
- `/health` 端点暴露 `activePages` 指标

### 5.3 💡 对 site-use 的借鉴价值

**可转移的模式**：

1. **广告域名屏蔽列表**：Firecrawl 屏蔽了 14 个广告/追踪域名。site-use 可以在 Puppeteer 的 `page.setRequestInterception()` 中做同样的事——减少页面加载时间、减少噪声 DOM 元素、降低被追踪风险。不是所有站点都需要，可以作为站点级可选配置。

2. **DNS 安全校验**：Firecrawl 阻止访问 localhost 和私有 IP，防止 SSRF。site-use 当前是本地工具，风险低，但如果未来支持用户输入 URL（如"帮我抓这个链接"），需要考虑类似防护。

**确认 site-use 的正确选择**：

3. **`load` 而非 `networkidle`**：Firecrawl 也只等 `load` 事件，没有用 `networkidle`（后者在 SPA 页面容易卡住）。site-use 的 `navigate()` 用同样策略是对的——需要等特定内容时，用 ARIA 匹配或 `evaluate()` 轮询，比 `networkidle` 更可控。

4. **无状态 vs 有状态的选择验证**：Firecrawl 每次请求创建新 context 是因为它是 SaaS——请求之间没有关联，不需要保持登录态。site-use 的 `Map<site, Page>` 长驻设计是正确的——操作 Twitter 需要登录态连续性，每次新建 context 会丢失 session。

**不需要的**：

- **信号量并发控制**：site-use 是单用户串行操作，Mutex 足够。
- **Docker 化部署**：本地工具，不需要容器隔离。
- **HTTP 微服务通信**：进程内直调，零序列化开销。

---

## 六、反检测与重试策略

轻量扫描。Firecrawl 是 SaaS 服务，用容器化 Chromium 大规模抓取，反检测需求与 site-use（本地真实 Chrome）完全不同。这里只关注**行为模式和重试逻辑**——这些与浏览器环境无关，可迁移。

### 6.1 错误分类体系

Firecrawl 定义了约 15 种错误类型（`error.ts`），按性质分三大类：

| 类别 | 错误类型 | 处理方式 |
|------|---------|---------|
| **特性检测** | `AddFeatureError`（发现 PDF/文档需要专用引擎）、`RemoveFeatureError` | 切换引擎重试 |
| **反爬阻断** | `PDFAntibotError`、`DocumentAntibotError`、`PDFPrefetchFailed` | 用 chrome-cdp 预取重试 |
| **基础设施** | `SiteError`（超时/连接重置）、`SSLError`、`DNSResolutionError`、`ProxySelectionError` | 直接传播，不重试 |
| **内容类型** | `UnsupportedFileError`（二进制文件） | 直接传播 |
| **引擎穷尽** | `NoEnginesLeftError` | 终态错误 |

### 6.2 重试策略

重试限制（`retryTracker.ts` + `config.ts`）：

| 参数 | 默认值 |
|------|--------|
| 全局重试上限 | 6 次 |
| 特性切换重试 | 3 次 |
| 反爬预取重试 | 2 次 |

重试逻辑（`index.ts:997-1078`）：
- **特性切换**：检测到未知文件类型 → 添加对应特性标志（pdf/document）→ 重试
- **反爬预取**：PDF 下载被反爬拦截 → 先用 chrome-cdp 预取页面 → 再下载 PDF
- **非重试错误**：`SiteError`、`DNSResolutionError`、`SSLError` 等直接传播

**没有指数退避**。HTTP 层（`fetch.ts`）支持可选的 `tryCooldown` 延迟，但默认不启用。fire-engine 轮询状态时有固定 500ms 间隔。

### 6.3 引擎瀑布中的错误处理

引擎竞赛中，错误分两类（`index.ts:628-731`）：

**立即传播（中断竞赛）**：
- 特性切换错误（需要在外层重试循环处理）
- 站点错误、SSL、DNS（换引擎也没用）
- 反爬阻断（需要不同策略，不是换引擎能解决）
- LLM 拒绝

**过滤掉（继续竞赛其他引擎）**：
- 通用 `EngineError`（该引擎不行，换一个可能行）
- 缓存未命中
- fire-engine 页面加载超时

### 6.4 URL 级配置

**域名引擎强制**（`engine-forcing.ts:20-93`）：
- 通过 `FORCED_ENGINE_DOMAINS` 环境变量配置
- 支持通配符：`*.example.com` 匹配子域名
- 支持 fallback 数组：`["fire-engine;chrome-cdp", "playwright"]`
- 当前硬编码：`digikey.com` 和 `lorealparis.hu` 强制用 tlsclient

**域名黑名单**（`blocklist.ts:40-107`）：
- 数据库驱动（Supabase）
- 匹配规则：精确域名 + 子域名 + 同名不同 TLD（如 `facebook.com` 也会阻止 `facebook.de`）
- 可被团队级 flag 和 URL 关键词白名单覆盖

### 6.5 💡 对 site-use 的借鉴价值

**值得参考的模式**：

1. **错误分类的粒度**：Firecrawl 把错误分成"可重试"和"不可重试"两大类，每类有明确的处理路径。site-use 当前设计了 5 类错误（`SessionExpired`、`ElementNotFound`、`ElementFoundByFallback`、`NavigationFailed`、`RateLimited`），可以借鉴 Firecrawl 的思路，给每类错误明确标注**重试策略**：哪些 Primitives 层内部重试、哪些直接抛给 caller。

2. **"立即传播 vs 继续尝试"的区分**：site-use 的 extractors.ts 如果有多种提取策略（GraphQL → DOM → LLM 兜底），也需要类似决策——GraphQL 拦截超时是换策略（继续尝试），还是直接报错（立即传播）？Firecrawl 的判断标准可以参考：**换了引擎/策略有可能解决的 → 继续尝试；跟引擎/策略无关的 → 立即传播**。

3. **域名级配置的思路**：site-use 扩展到多站点后，不同站点可能需要不同的 throttle 参数、提取策略、反爬强度。Firecrawl 的"域名 → 配置"映射思路可以演化为 site-use 的"站点 → 配置"映射，在 sites 层的站点注册时声明。

**不需要的**：

- **引擎瀑布和竞赛**：site-use 只有一个引擎（Puppeteer），不需要。
- **全局重试上限**：site-use 的重试在 Primitives 层内部（2-3 次临时失败），不需要全局计数器。
- **域名黑名单**：site-use 的站点是开发者显式接入的，不存在"意外访问有害域名"的场景。
- **Stealth proxy / mobile proxy**：site-use 用真实 Chrome + 用户配置的代理，不需要 Firecrawl 的代理切换机制。

---

## 七、新站点接入决策流程

site-use 以 Twitter 切入，但未来会扩展到更多站点。每接入一个新站点，核心问题是：**用什么提取策略？** 这是一个事前的 research 流程，产出是确定的策略选择，之后固化为 workflow 代码，运行时不再决策。

### 7.1 决策树

```
新站点接入
  │
  ▼
┌────────────────────────────────────────┐
│ Step 1：打开 DevTools Network 面板      │
│ 操作目标页面（滚动、点击、搜索）         │
│ 观察网络请求                            │
└──────────────┬─────────────────────────┘
               │
               ▼
        有结构化 API 请求？
      （GraphQL / REST JSON）
        ┌──── 是 ────┐
        │            │
        ▼            ▼ 否
  ┌──────────┐  ┌────────────────────────┐
  │ 最优路径  │  │ Step 2：Console 面板    │
  │ 拦截 API │  │ 检查 JS 全局状态对象     │
  │ 响应     │  │ __INITIAL_STATE__       │
  └──────────┘  │ __NEXT_DATA__          │
                │ React fiber / store     │
                └──────────┬─────────────┘
                           │
                           ▼
                   有可用状态对象？
                 ┌──── 是 ────┐
                 │            │
                 ▼            ▼ 否
           ┌──────────┐  ┌──────────────────┐
           │ 次优路径  │  │ Step 3：DOM 结构  │
           │ evaluate  │  │ 检查语义化标签     │
           │ 读状态    │  │ + ARIA 属性       │
           └──────────┘  └────────┬─────────┘
                                  │
                                  ▼
                          DOM 结构清晰？
                        ┌──── 是 ────┐
                        │            │
                        ▼            ▼ 否
                  ┌──────────┐  ┌──────────────┐
                  │ 可用路径  │  │ 兜底路径      │
                  │ DOM 解析  │  │ 清洗 HTML     │
                  │ + 选择器  │  │ + LLM 提取    │
                  └──────────┘  └──────────────┘
```

### 7.2 各策略评估维度

| 维度 | API 拦截 | JS 状态对象 | DOM 解析 | LLM 兜底 |
|------|---------|------------|---------|---------|
| **抗改版能力** | 高（API 契约比 UI 稳定） | 中（框架升级可能变） | 低（DOM 改版频繁） | 高（不依赖结构） |
| **数据完整性** | 高（API 返回完整字段） | 高（前端状态含所有数据） | 中（部分字段可能隐藏） | 中（依赖 LLM 理解力） |
| **实现成本** | 中（需逆向 API 格式） | 低（一行 evaluate） | 低（选择器编写） | 中（prompt 调优 + 成本） |
| **运行时成本** | 零（纯数据拦截） | 零（纯 JS 执行） | 零（纯 DOM 操作） | 高（LLM API 调用） |
| **延迟** | 低（数据随页面加载到达） | 低（同步读取） | 低（同步解析） | 高（LLM 响应时间） |

### 7.3 Research Spike 检查清单

每个新站点接入前，按此清单逐项检查，产出一份简短的策略决策记录：

**网络层检查**：
- [ ] 目标操作（浏览列表、搜索、查看详情）触发了哪些 API 请求？
- [ ] API 返回 JSON 还是其他格式？
- [ ] API 是否需要认证 token？token 从哪来？（通常 cookies 里有）
- [ ] API endpoint 是否带版本号或 hash？（有 hash 的 GraphQL 可能频繁变化）

**JS 状态检查**：
- [ ] `window.__INITIAL_STATE__` 或 `window.__NEXT_DATA__` 是否存在？
- [ ] React DevTools 能否看到组件树和 state？
- [ ] 数据是否在首屏渲染时就存在（SSR），还是动态加载？

**DOM 结构检查**：
- [ ] 目标内容有没有语义化容器？（`<article>`、`role="listitem"` 等）
- [ ] 关键字段（标题、作者、时间、正文）能否用稳定选择器定位？
- [ ] 时间戳是真实值还是"3 小时前"这种相对格式？

**操作层检查**（与提取策略无关，但接入时一并完成）：
- [ ] 关键交互元素的 ARIA 属性是否完善？（role + name）
- [ ] 站点是否有反爬保护？什么级别？（Cloudflare / 自研 / 无）
- [ ] 是否需要代理？

**产出**：一份策略决策记录，格式如：
```
站点：reddit.com
提取策略：API 拦截（Reddit JSON API，无需 GraphQL）
操作策略：ARIA 匹配（Reddit 无障碍支持良好）
反爬等级：低（Reddit 对浏览器访问宽松）
特殊注意：无限滚动需要停滞检测
```

### 7.4 策略固化

决策完成后，策略固化为 workflow 代码：

```
sites/
  └─ reddit/
      ├─ matchers.ts      ← 操作定位规则（来自 ARIA 检查结果）
      ├─ workflows.ts     ← 操作流程
      └─ extractors.ts    ← 提取实现（来自策略决策）
                              内部用 API 拦截 / JS 状态 / DOM / LLM
                              对 workflow 暴露统一接口
```

workflow 层只调 `extractors.getItems(page): Promise<T[]>`，不关心内部用了哪种策略。运行时不再做策略选择。

---

## 八、总结：可执行的借鉴清单

### 确定纳入的

| 编号 | 借鉴内容 | 来源 | 落地位置 | 时机 |
|------|---------|------|---------|------|
| F1 | 对抗性文本防护（prompt injection 防御） | LLM 提取层 prompt 模板 | LLM 兜底 extractor 的 system prompt | LLM 兜底实现时 |
| F2 | Schema 驱动 LLM 提取（Zod → JSON Schema → generateObject） | LLM 提取层 | LLM 兜底 extractor | LLM 兜底实现时 |
| F3 | 模型路由（简单用 mini，失败升级强模型） | LLM 提取层模型选择 | LLM 兜底 extractor | LLM 兜底实现时 |
| F4 | 成本上限机制 | CostTracking 类 | LLM 兜底 extractor | LLM 兜底实现时 |
| F5 | HTML 清洗规则清单（噪声元素选择器） | removeUnwantedElements | 清洗工具函数（独立于 extractor） | LLM 兜底实现时 |
| F6 | `onlyMainContent` 模式（LLM 前置清洗减 token） | HTML 清洗层 | 清洗工具函数 | LLM 兜底实现时 |
| F7 | 错误分类：可重试 vs 不可重试的明确标注 | 错误分类体系 | site-use 错误类型定义 | M3（错误处理增强） |
| F8 | 广告/追踪域名屏蔽列表 | Playwright 服务请求过滤 | 站点级可选配置 | 按需 |
| F9 | 新站点接入决策流程 | 综合分析产出 | `docs/` 下的 SOP 文档 | 扩展第二个站点时 |

### 架构预留（不写代码，确保不阻断）

| 编号 | 预留点 | 要求 |
|------|--------|------|
| R1 | extractor 接口 | 保持 `(page) => Promise<T[]>` 签名，不暴露提取策略给 workflow |
| R2 | 清洗层独立性 | HTML 清洗作为独立工具函数，不绑定在特定 extractor 内部 |
| R3 | Schema 单一来源 | Zod 类型定义是唯一 schema 来源，LLM 路径直接复用，不维护两套 |

### 明确不需要的

- **引擎选择 / 瀑布竞赛**：site-use 只有 Puppeteer，不需要多引擎调度
- **Markdown 作为中间格式**：site-use 的确定性路径直接产出业务对象，不需要 Markdown 中间层（LLM 兜底路径除外）
- **多级 Markdown 转换 fallback**（HTTP 微服务 / Go FFI）：本地单用户场景，JS 实现足够
- **URL 发现 + 重排序**：site-use 的目标页面是确定的
- **Schema 分析（单实体 vs 多实体）**：site-use 知道自己要什么类型
- **无状态浏览器模型**：site-use 需要登录态连续性
- **信号量并发 / Docker 部署**：本地单用户工具
- **Stealth proxy / 代理切换**：真实 Chrome + 用户配置代理
