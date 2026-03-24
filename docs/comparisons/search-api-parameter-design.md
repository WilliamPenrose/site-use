# Search API 参数设计对比

> **版本**: 2026-03-24 · **来源**: Brave Search API, Tavily Search API 官方文档
> **目标读者**: site-use 项目开发者
>
> 用途：对比主流 AI 搜索 API 的参数设计，为 site-use search（CLI + MCP tool）的参数命名和功能设计提供参考

## 设计背景

site-use search 有两个消费者：
- **MCP tool** — AI agent 通过 JSON Schema 调用
- **CLI** — 人类通过命令行调用

两层参数命名保持一致，优先 AI 友好。核心参考对象是 **Tavily**（AI-first 搜索 API）。

---

## 一、Brave Search API 完整参数

**端点**: `GET https://api.search.brave.com/res/v1/web/search`

### 核心参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `q` | string | 是 | — | 搜索查询，最大 400 字符 / 50 词 |
| `count` | int | 否 | 20 | 结果数，1-20 |
| `offset` | int | 否 | 0 | 页偏移，0-9 |
| `freshness` | string | 否 | — | 时间过滤：`pd`/`pw`/`pm`/`py` 或 `YYYY-MM-DDtoYYYY-MM-DD` |
| `safesearch` | enum | 否 | moderate | `off` / `moderate` / `strict` |

### 语言与地区

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `country` | string | US | 结果来源国家，ISO 3166-1 alpha-2 |
| `search_lang` | string | en | 搜索语言 |
| `ui_lang` | string | en-US | UI 语言，RFC 9110 |
| `units` | enum | auto | 度量单位：`metric` / `imperial` |

### 结果控制

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `result_filter` | string | all | 逗号分隔，可选：`web`, `news`, `videos`, `images`, `discussions`, `faq`, `infobox`, `query`, `summarizer`, `locations` |
| `text_decorations` | bool | true | 摘要是否含高亮标记 |
| `extra_snippets` | bool | false | 每条结果额外返回最多 5 条备选摘录（Pro 计划） |
| `summary` | bool | false | 启用 AI 摘要 |

### 其他

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `spellcheck` | bool | true | 拼写检查 |
| `goggles` | string | — | 自定义排序规则（替代已废弃的 `goggles_id`） |
| `operators` | bool | true | 是否解析搜索运算符（`site:`, `filetype:` 等） |
| `no_cache` | bool | false | 禁用服务端缓存 |

### 地理位置 Headers

通过 HTTP Header 传递，用于本地化结果：`X-Loc-Lat`, `X-Loc-Long`, `X-Loc-Timezone`, `X-Loc-City`, `X-Loc-State`, `X-Loc-Country`, `X-Loc-Postal-Code`

---

## 二、Tavily Search API 完整参数

**端点**: `POST https://api.tavily.com/search`

### 核心参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 搜索查询 |
| `max_results` | int | 否 | 5 | 结果数，0-20 |
| `search_depth` | enum | 否 | basic | `ultra-fast` / `fast` / `basic` / `advanced` |
| `topic` | enum | 否 | general | `general` / `news` / `finance` |

### 时间过滤

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `time_range` | enum | null | 相对时间：`day`/`week`/`month`/`year`（别名 `d`/`w`/`m`/`y`） |
| `start_date` | string | null | 精确起始日期，`YYYY-MM-DD` |
| `end_date` | string | null | 精确截止日期，`YYYY-MM-DD` |

### 内容控制

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `include_answer` | bool/string | false | AI 生成答案：`true`/`"basic"`/`"advanced"` |
| `include_raw_content` | bool/string | false | 原文内容：`true`/`"markdown"`/`"text"` |
| `include_images` | bool | false | 包含图片结果 |
| `include_image_descriptions` | bool | false | 图片描述（需 `include_images` 开启） |
| `include_favicon` | bool | false | 包含 favicon URL |

### 过滤

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `include_domains` | string[] | [] | 限定域名，最多 300 |
| `exclude_domains` | string[] | [] | 排除域名，最多 150 |
| `country` | string | null | 结果来源国家（小写全名，如 `"united states"`） |
| `exact_match` | bool | false | 精确短语匹配 |
| `safe_search` | bool | false | 安全搜索（Enterprise 计划） |

### 其他

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `auto_parameters` | bool | false | 让 Tavily 自动配置参数 |
| `chunks_per_source` | int | 3 | 每个来源的内容块数，1-3 |
| `include_usage` | bool | false | 返回 credit 用量信息 |

### 返回值

不返回 total count。返回 `results`（含 title, url, content, score）、可选的 `answer`、`images`、`response_time`。

---

## 三、site-use search 改造后参数对比

| 功能 | Tavily | site-use (改造后) | 差异说明 |
|------|--------|------------------|---------|
| **查询** | `query` (required) | `query` (optional) | site-use 可无 query 纯过滤 |
| **结果数** | `max_results` (默认5, 最大20) | `max_results` (默认20) | 同名，默认值不同 |
| **分页偏移** | 无 | 无 | 一致 |
| **时间过滤(相对)** | `time_range`: day/week/month/year | 无 | 不加，AI 直接算日期 |
| **时间过滤(精确)** | `start_date` / `end_date` (YYYY-MM-DD) | `start_date` / `end_date` (本地时间, 灵活格式) | 同名，site-use 支持更宽松的输入 |
| **作者** | 无 | `author` | 领域特有 |
| **Hashtag** | 无 | `hashtag` | 领域特有 |
| **互动量过滤** | 无 | `min_likes` / `min_retweets` | 领域特有 |
| **域名过滤** | `include_domains` / `exclude_domains` | 无 | site-use 是单站点，不需要 |
| **字段选择** | `include_raw_content` / `include_images` 等开关 | `fields` + enum | Tavily 用开关，site-use 用字段枚举 |
| **AI 摘要** | `include_answer` | 无 | 不在 search 职责内 |
| **搜索深度** | `search_depth` | 无 | 本地 FTS 无此概念 |
| **地区/语言** | `country` | 无 | 本地库不需要 |
| **安全搜索** | `safe_search` | 无 | 不需要 |
| **输出格式** | 固定 JSON | `json` (bool) | CLI 需要人类可读模式 |
| **返回总数** | 不返回 | 不返回 | 去掉 total |
| **排序** | 固定相关性 | 固定时间倒序 | 后续考虑综合打分 |

---

## 四、设计决策记录

### 为什么参数命名对齐 Tavily 而非 Brave？

Tavily 是 AI-first 产品，参数设计面向 LLM 消费：
- `query` > `q` — 自描述，AI 不需要知道缩写约定
- `max_results` > `count` — 语义明确
- `start_date` / `end_date` > `freshness` — 精确日期区间，AI 可以轻松计算

### 为什么不加相对时间（time_range）？

AI agent 不需要 `day`/`week` 这种快捷方式——它能直接算出具体日期填入 `start_date`。减少一个参数就减少一个歧义源。

### 为什么字段选择用 `fields` + enum 而非 `include_X` 开关？

site-use 未来会支持多个 site（twitter、reddit、xiaohongshu...），每个 site 的字段不同。`include_X` 开关会随字段增长而爆炸，`fields` + enum 更灵活。同时通过 JSON Schema enum 约束，AI 能在 schema 中直接看到所有合法值，不需要猜测。

### 为什么去掉 total？

Brave、Tavily、Exa 都不返回 total。原有 total 设计是为了 AI agent 判断是否需要翻页，但懒计算的方式（仅在 `rows.length == limit` 时才执行 COUNT）已经足够。CLI 展示层面也不再需要显示总数。

### 排序为什么暂不开放？

当前固定时间倒序。理想场景需要综合打分（相关性 × 时间衰减 × 互动量加权），但这属于搜索排序引擎范畴，复杂度较高，等数据量上来后再考虑。
