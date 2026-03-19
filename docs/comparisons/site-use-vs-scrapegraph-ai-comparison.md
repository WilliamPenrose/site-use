# site-use vs ScrapeGraphAI 对比分析

> **版本**: 2026-03-19 · **来源**: Scrapegraph-ai@`cf9b87e9` (main)
> **目标读者**: site-use 架构师——M1 提取策略选择、M4 反改版方案评估、长期架构判断

## 前提说明

两者架构哲学完全不同：
- **ScrapeGraphAI** 是 LLM 驱动的通用爬取框架（Python），目标是"用自然语言描述需求，AI 自动从页面提取结构化数据"
- **site-use** 是站点专属浏览器自动化工具（TypeScript），目标是"确定性 workflow + 真实浏览器操作特定平台"

本文不评判优劣，聚焦：**ScrapeGraphAI 的哪些核心机制值得 site-use 借鉴？哪些不适用？**

---

## 一、Graph Pipeline 架构模型

### 1.1 核心抽象

ScrapeGraphAI 用两层抽象实现图管道：

| 层级 | 类 | 职责 |
|------|---|------|
| **执行引擎** | `BaseGraph` | 存储节点列表 + 边字典，驱动顺序执行，支持条件分支 |
| **图模板** | `AbstractGraph` | 抽象基类，负责 LLM 初始化、配置分发、调用 `_create_graph()` 构建具体管道 |

**执行模型**：**严格顺序执行 + 条件分支**，不是真正的 DAG。数据通过一个共享 dict（state）在节点间传递，每个节点就地修改 state。

### 1.2 节点粒度与图类型

共 **24 种图类型**，核心模式只有 3 种：

| 模式 | 节点数 | 典型流程 | 代表图 |
|------|--------|---------|--------|
| **最小管道** | 2-3 | Fetch → Parse → GenerateAnswer | SmartScraperLiteGraph |
| **标准管道** | 3-4 | Fetch → Parse → [Reasoning] → GenerateAnswer | SmartScraperGraph |
| **搜索管道** | 3 | SearchInternet → GraphIterator → MergeAnswers | SearchGraph |

24 种图的差异主要在于：输入源不同（URL / CSV / JSON / 截图）、是否带搜索、是否批量处理。本质上都是 **线性管道的变体**。

### 1.3 数据流机制

```
Initial State: {user_prompt: "...", url: "https://..."}
    ↓
FetchNode → state += {doc: "..."}
    ↓
ParseNode → state += {parsed_doc: "..."}
    ↓
GenerateAnswerNode → state += {answer: {...}}
    ↓
返回 state["answer"]
```

节点用布尔表达式声明输入依赖：`input="user_prompt & (relevant_chunks | parsed_doc | doc)"`，从 state 中匹配可用键。

### 1.4 错误处理

**极其粗糙**：
- 任何节点抛异常 → 整个图失败，异常直接上抛
- 无重试、无 fallback 路径
- 唯一的"容错"：SmartScraperGraph 的 `ConditionalNode` 检查答案是否为空/NA，触发一次重试
- 超时保护：LLM 调用默认 480 秒超时

### 1.5 [推导] 图模型的实际价值评估

**带来了什么：**
- 节点复用——ParseNode、GenerateAnswerNode 在 15+ 种图中复用
- 声明式构建——`_create_graph()` 中组装节点，可读性尚可
- 批量处理——GraphIteratorNode 封装了并发执行多个图实例

**没有带来什么：**
- 无真正 DAG 并行（只有 GraphIteratorNode 包装的并发）
- 无数据隔离（共享 state dict，分支不隔离状态）
- 无提前终止、无错误恢复路径

**结论：过度抽象。** 24 种图绝大多数是 2-5 个节点的线性管道，用简单的函数调用链即可实现。图抽象增加了节点注册、输入表达式解析、state dict 管理的复杂度，但没有换来等价的灵活性。对于 site-use 的线性 workflow（navigate → snapshot → match → click → extract），**不需要引入图模型**。

---

## 二、LLM 提取流程与 Token 优化

### 2.1 提取管道全景

ScrapeGraphAI 的 LLM 提取是一条 4 阶段管道：

```
原始 HTML → 清洗/转 Markdown → Token 分块 → LLM 提取 → 结构化输出
```

### 2.2 HTML 清洗与 Token 优化

这是 ScrapeGraphAI 最有实用价值的部分。三层递进清洗：

**第一层：`cleanup_html()` —— 结构提取**
- 分离 title、body、链接、图片、脚本内容
- 提取 `<script>` 中的 JSON 变量（`const data = {...}`）和 `window.*` 赋值
- 删除所有 `<style>` 标签
- 用 `minify-html` 库压缩 body

**第二层：`reduce_html()` —— 三级递进裁剪**

| 级别 | 策略 | Token 削减 |
|------|------|-----------|
| 0 | 仅 minify（删注释、压缩空白） | ~20% |
| 1 | + 仅保留 class/id/href/src/type 属性，删其余 | ~40% |
| 2 | + 删 style 标签 + 文本节点截断到 20 字符 + 删 head | ~60-70% |

**第三层：`convert_to_md()` —— HTML 转 Markdown**
- 用 `html2text` 库将 HTML 转为 Markdown
- 保留语义结构（标题、列表、表格、链接）
- 删除所有 CSS class/id/内联样式
- Token 削减约 **30-40%**
- **仅对 OpenAI 系模型启用**（其他模型传原始 HTML）

**[推导] 关键发现：脚本内容提取**

`cleanup_html()` 会从 `<script>` 标签中用正则提取 JSON 数据：
```python
# 匹配 const/let/var 声明的 JSON 对象
r'(?:const|let|var)?\s*\w+\s*=\s*({[\s\S]*?});?$'
# 匹配 window.*/document.* 赋值
r'(?:window|document)\.(\w+)\s*=\s*([^;]+);'
```

这对 Twitter 场景有参考意义——Twitter 的推文数据确实以 JSON 形式嵌在 `<script>` 和 `window.__INITIAL_STATE__` 中。但正则提取的可靠性远低于 CDP 网络拦截。

### 2.3 Token 分块策略

- **分块器**：`semchunk` 库（语义感知分块，不在句子中间断开）
- **Token 计数**：`tiktoken`（GPT-4o 编码）
- **块大小**：模型最大 token 数 - 250
- **处理方式**：
  - 单块 → 直接传 LLM
  - 多块 → 并行处理各块 → 合并阶段整合结果

### 2.4 LLM 提取的 Prompt 设计

核心 prompt 模板（简化）：

```
你是一个网站爬虫。根据用户问题从网页内容中提取信息。
如果找不到答案，值设为 "NA"。
确保输出为有效 JSON 格式。
输出格式要求：{format_instructions}   ← Pydantic schema 注入
用户问题：{question}
网页内容：{content}
```

多块合并 prompt：
```
将以下多个部分结果合并为一个答案，去除重复和矛盾。
如果指定了最大条目数，确保返回该数量。
```

**[推导] Prompt 的局限性**：
- 没有页面结构提示（不告诉 LLM 这是什么类型的页面）
- 没有字段级引导（不说明哪些字段来自哪种 DOM 区域）
- 完全依赖 LLM 的"理解能力"暴力提取

### 2.5 结构化输出保障

| LLM 类型 | 输出策略 |
|----------|---------|
| ChatOpenAI | `JsonOutputParser(pydantic_object=schema)` |
| ChatOllama | 将 schema 设为模型的 `.format` 参数 |
| 其他 | 通用 `JsonOutputParser()`（无 schema 约束） |

验证层：
- Pydantic v2 自动验证字段类型
- LangChain 的 OutputParser 处理 JSON 解析
- **无语义验证**（不检查值是否合理，只检查格式）

### 2.6 [推导] 对 Twitter Timeline 场景的成本估算

假设：50 条推文的 timeline 页面，HTML 约 200KB（~50,000 tokens）

| 阶段 | Token 消耗 | 成本（GPT-4o） |
|------|-----------|---------------|
| HTML → Markdown | ~30,000 tokens（输入） | - |
| 分块（~15 块 × 2,000 tokens） | 15 次 LLM 调用，每次 ~2,500 input + ~500 output | ~$0.05 |
| 合并阶段 | ~8,000 input + ~2,000 output | ~$0.01 |
| **单次提取总计** | ~45,000 input + ~9,500 output | **~$0.06** |
| **每天 10 次** | | **~$0.60/天** |
| **每月** | | **~$18/月** |

对比：site-use 的确定性提取（DOM 解析 / GraphQL 拦截）成本为 **$0/月**。

**[推导] 延迟估算**：15 次并行 LLM 调用 + 1 次合并 ≈ 3-8 秒（取决于 API 响应速度），vs 确定性提取的 <100ms。

### 2.7 关键判断：LLM 提取是否值得作为 M1 第 5 种候选？

**不值得作为主力方案**，原因：
- 50 条推文 × 每天多次 = 高频重复结构场景，确定性提取的 ROI 远高于 LLM
- 延迟 3-8 秒 vs <100ms，用户体验差距巨大
- 月成本 $18 vs $0，且随调用频率线性增长

**但值得作为 fallback 候选**（见第五节）。

---

## 三、反改版能力机制

### 3.1 ScrapeGraphAI 的"自动适应改版"——真相

**号称的能力**：网站结构变化后，无需修改代码即可继续提取。

**实际机制**：**没有任何自适应机制**。每次执行都是无状态的：

1. 抓取 HTML → 清洗 → 传给 LLM → LLM 重新理解页面 → 提取
2. 没有指纹缓存、没有历史对比、没有学习机制
3. 零持久化——上一次抓取的结果不会影响下一次

所谓"自动适应"的本质是：**LLM 每次都从零开始理解页面，不依赖任何固定选择器，所以选择器失效这件事根本不存在。**

### 3.2 这种"暴力理解"的可靠性分析

**有效场景**（结构变但语义不变）：
- CSS class 名从 `tweet-text` 改为 `css-1dbjc4n` → LLM 不看 class，靠文本语义识别 ✓
- DOM 层级从 div>div>span 变成 div>article>p → LLM 不看路径 ✓
- 页面布局大改但内容不变 → LLM 照样能找到 ✓

**失效场景**：
- 内容本身变了（字段改名、数据格式变化） → LLM 可能提取错误字段
- 页面增加大量无关内容（广告、推荐） → 稀释目标内容，增加 token 消耗和误提取概率
- 关键数据从 HTML 移到 JS 动态渲染（不在初始 DOM 中） → 抓不到
- 数据从可见文本变成图片/canvas → 无法提取

### 3.3 与 site-use M4 Fingerprint Fallback 的对比

| 维度 | ScrapeGraphAI（LLM 暴力理解） | site-use（ARIA + Fingerprint） |
|------|------------------------------|-------------------------------|
| **首次成本** | 高（每次都要 LLM 调用） | 低（ARIA 选择器直接命中） |
| **改版后成本** | 不变（每次都一样贵） | 中等（fingerprint 重定位，可能需人工确认） |
| **准确率（正常）** | 90-95%（LLM 理解有概率出错） | ~100%（确定性匹配） |
| **准确率（改版后）** | 80-90%（取决于变化程度） | 90-95%（fingerprint 相似度匹配） |
| **延迟** | 3-8 秒 | <100ms |
| **可审计性** | 差——LLM 输出不可解释 | 好——选择器/指纹可追溯 |
| **维护成本** | $0 人工 + $18/月 API | 偶尔更新 matchers.ts + $0 API |

### 3.4 关键判断（考虑多站点扩展）

matchers.ts + fingerprint 对 **Twitter 单站点**是正确选择。但 site-use 的目标是高效支持大量站点，这改变了评估：

- 每新增一个站点，需要手写 ARIA matchers + 可能的 fingerprint 配置
- 不同站点的 ARIA 支持水平参差不齐（Twitter 优秀，但很多站点 ARIA 稀烂）
- 站点越多，matchers 维护的总成本线性增长

**因此：确定性方案是主力，但 LLM 提取作为"新站点冷启动"和"ARIA 缺失站点"的辅助手段，价值随站点数量增加而提升。** 详见第五节建议。

---

## 四、浏览器控制能力边界

### 4.1 ScrapeGraphAI 的浏览器能力

底层用 **Playwright**（默认）和 **Undetected ChromeDriver**（备选），但能力被严格限制在"获取页面内容"这一步。

**能做的：**

| 能力 | 实现方式 | 备注 |
|------|---------|------|
| 页面加载 | Playwright `goto()` | 支持 domcontentloaded / networkidle / load 三种等待策略 |
| 滚动加载 | `ascrape_playwright_scroll()` | 可配置滚动步长（默认 15000px）、支持滚到底部、监测高度变化判断加载完成 |
| Cookie 登录 | `storage_state` 参数 | 加载预先保存的 JSON cookie 文件 |
| 截图 | `FetchScreenNode` | 截图后传 LLM 分析 |
| 反检测 | `undetected_playwright.Malenia.apply_stealth()` | 掩盖 headless 浏览器指纹 |
| 慢速模式 | `slow_mo` 参数 | 模拟人类操作节奏（毫秒级延迟） |
| 代理 | `proxy` 配置 + `search_proxy_servers()` | 支持认证代理和免费代理轮换 |

**不能做的（关键缺失）：**

| 能力 | 状态 | 影响 |
|------|------|------|
| 点击元素 | ❌ 管道内不支持 | 无法做 follow、like、展开评论 |
| 表单填写 | ❌ 管道内不支持 | 无法做搜索输入 |
| 等待特定元素 | ❌ 无选择器等待 | 依赖全局等待策略，不精确 |
| JS 执行 | ❌ 未暴露 | 无法调用页面 JS 或注入脚本 |
| 网络拦截 | ❌ 未实现 | 无法拦截 GraphQL/API 响应 |
| CDP 协议 | ❌ 未暴露 | 无法做底层浏览器控制 |
| 鼠标轨迹模拟 | ❌ 未实现 | 反检测上界低于真实用户模拟 |
| 多步交互链 | ❌ 不在架构中 | 必须在管道外部手动编排 |

### 4.2 认证流程的尴尬处理

ScrapeGraphAI 处理登录的方式暴露了其架构局限：

```python
# examples/extras/authenticated_playwright.py
# 第一步：在管道外部手动用 Playwright 登录
browser = playwright.chromium.launch(headless=False)
page.get_by_label("Email").fill("user@example.com")
page.get_by_role("button", name="Sign in").click()
context.storage_state(path="./state.json")  # 保存 cookie

# 第二步：把 cookie 传给图管道
graph_config = {"loader_kwargs": {"storage_state": "./state.json"}}
smart_scraper = SmartScraperGraph(config=graph_config, ...)
```

**登录交互在管道外完成，管道本身只消费 cookie。** 这意味着任何需要交互的操作（关闭弹窗、处理验证码、点击"加载更多"）都无法在图管道内实现。

### 4.3 与 site-use Primitives 层的对比

| 维度 | ScrapeGraphAI | site-use（Puppeteer + CDP + 6 原语） |
|------|--------------|--------------------------------------|
| **定位** | 获取页面内容的工具 | 操作浏览器的代理 |
| **交互能力** | 仅获取（fetch + scroll） | 完整操作（navigate, click, type, scroll, extract, wait） |
| **反检测** | Playwright stealth + proxy | CDP 直连 + 指纹控制 + 真实用户行为模拟 |
| **网络层** | 不可见 | CDP 拦截请求/响应（可抓 GraphQL） |
| **状态管理** | 外部 cookie 注入 | 浏览器实例持久化，完整会话管理 |
| **扩展性** | 加节点（仅限提取逻辑） | 加原语 + 加 workflow（操作 + 提取均可扩展） |

### 4.4 关键判断（区分提取与操作）

site-use 有两大能力维度：

| 维度 | 典型场景 | ScrapeGraphAI 覆盖？ |
|------|---------|---------------------|
| **提取内容** | 抓取 timeline 推文、获取用户 profile 信息、采集搜索结果 | ✅ 能力范围内（HTML → LLM → 结构化数据） |
| **操作网页** | follow、like、搜索输入、关闭弹窗、处理登录 | ❌ 完全不在能力范围 |

**操作维度**：ScrapeGraphAI 无法替代 site-use 的 Primitives 层，没有争议。

**提取维度**：ScrapeGraphAI 的 LLM 提取与 site-use 的确定性提取（DOM 解析 / ARIA 匹配 / GraphQL 拦截）形成直接对比。两者的 tradeoff 见第二、三节分析。

关键区别在于：site-use 的提取往往嵌在操作流程中（scroll → 提取新内容 → 继续 scroll），需要提取步骤**低延迟、可内联**。LLM 提取的 3-8 秒延迟在独立提取场景可接受，但嵌入操作循环时会严重拖慢整体流程。

### 4.5 [推导] 多站点扩展视角下的能力边界

当 site-use 扩展到新站点时，每个站点都可能需要：
1. **站点特定的登录流程**（OAuth、手机验证、验证码）
2. **站点特定的反检测策略**（不同平台检测手段不同）
3. **站点特定的交互模式**（有的用 infinite scroll，有的用分页，有的用 "Load More" 按钮）

ScrapeGraphAI 的架构无法承载这些——它假设"给我 HTML，我提取数据"，但获取 HTML 这一步恰恰是最难的。site-use 的 Primitives 层 + workflow 编排才是解决这些问题的正确抽象层级。

但在纯提取环节，ScrapeGraphAI 的 LLM 方案对"ARIA 支持差的站点"和"新站点冷启动"有独特价值——不需要理解 DOM 结构就能提取数据，大幅降低新站点接入的前期投入。

---

## 五、对比矩阵与具体建议

### 5.1 总体对比矩阵

| 维度 | ScrapeGraphAI | site-use | 判断 |
|------|--------------|----------|------|
| **架构哲学** | LLM 驱动，每次从零理解页面 | 确定性 workflow，规则绑定 | 各有适用场景 |
| **提取准确率** | 90-95%（LLM 理解有概率出错） | ~100%（确定性匹配） | site-use 胜 |
| **提取延迟** | 3-8 秒（LLM API 调用） | <100ms（本地 DOM/GraphQL） | site-use 胜 |
| **提取成本** | ~$0.06/次，随调用量线性增长 | $0 | site-use 胜 |
| **新站点接入速度** | 极快——只需描述"要什么数据" | 需手写 matchers + workflow | ScrapeGraphAI 胜 |
| **ARIA 差的站点** | 不受影响（不依赖 ARIA） | ARIA 匹配失效，需 fingerprint 或手写选择器 | ScrapeGraphAI 胜 |
| **反改版（高频站点）** | 每次 $0.06，年化成本高 | ARIA + fingerprint 双层，年化成本低 | site-use 胜 |
| **反改版（低频站点）** | 零维护 | 维护 matchers 的 ROI 变低 | ScrapeGraphAI 胜 |
| **操作能力** | 无（仅提取） | 完整（6 原语 + workflow） | site-use 胜 |
| **可审计性** | 差（LLM 黑盒） | 好（选择器/指纹可追溯） | site-use 胜 |
| **HTML 清洗** | 成熟的三层管道 | 未涉及（不需要传 LLM） | 可借鉴 |

### 5.2 核心发现

ScrapeGraphAI 的优势集中在两个点：

1. **新站点冷启动极快**——不需要理解站点 DOM 结构，不需要写 matchers，描述需求就能提取
2. **对 ARIA 差的站点天然适用**——不依赖任何特定属性

这两个优势恰好对应 site-use 多站点扩展时的痛点：**每新增一个站点，都要投入人力分析 DOM、编写 matchers、调试 workflow。**

### 5.3 具体建议

#### ✅ 采纳：HTML 清洗管道（用于未来 LLM 辅助提取）

ScrapeGraphAI 的三层 HTML 清洗值得移植：
- `reduce_html()` 的三级裁剪策略（属性精简 → 文本截断 → 结构简化）
- HTML → Markdown 转换减少 30-40% token
- `<script>` 中 JSON 数据的正则提取

即使 site-use 当前不用 LLM 提取，HTML 清洗管道在以下场景有用：
- 调试时快速查看页面核心内容（去噪后更易读）
- 未来引入 LLM fallback 时已有基础设施
- 对外输出页面摘要时减少数据量

**建议**：不急于实现，但在 M1 的 primitives 设计中预留 `cleanHtml()` 工具函数的位置。

#### ✅ 采纳：LLM 提取作为 fallback 层（非主力）

在 site-use 的提取策略栈中增加 LLM 作为最后一层：

```
提取策略栈（按优先级）：
1. GraphQL / API 拦截     ← 最快最准，但不是所有站点都有
2. JS 状态对象提取         ← window.__INITIAL_STATE__ 等
3. ARIA 语义匹配 + DOM 解析 ← 主力方案
4. Fingerprint 相似度重定位  ← 改版后 fallback
5. LLM 提取（新增）         ← 终极 fallback
```

触发条件：
- 前 4 层全部失败（如全新站点首次接入、站点大改版导致所有选择器失效）
- 新站点冷启动阶段：先用 LLM 提取跑通 POC，确认可行后再投入人力写确定性规则
- ARIA 支持差的站点：LLM 提取可能比手写脆弱的 CSS 选择器更可靠

**不建议用 ScrapeGraphAI 本身**（Python、图管道过度抽象），而是借鉴其提取思路：
- 清洗 HTML → 传 LLM → Pydantic schema 约束输出
- 自行用 TypeScript 实现，几十行代码即可

#### ✅ 采纳：Pydantic Schema 约束输出的模式

ScrapeGraphAI 用 Pydantic schema 定义期望输出格式，LLM 被约束在 schema 内填充字段。这个模式可以直接映射到 site-use 的 TypeScript 生态：

- 用 Zod schema 替代 Pydantic
- 将 schema 序列化为 JSON Schema 注入 prompt
- LLM 输出用 Zod `.parse()` 验证

这保证了 LLM fallback 的输出与确定性提取的输出结构一致，上层消费方无需区分数据来源。

#### ✅ 采纳：新站点冷启动流程

多站点扩展的核心瓶颈是"每个站点都要从零分析"。借鉴 ScrapeGraphAI 的思路，设计冷启动流程：

```
新站点接入流程：
1. LLM 提取 POC（1 小时）→ 验证"这个站点的数据是否可提取"
2. 分析 DOM 结构（借助 LLM 辅助）→ 识别 ARIA 支持水平
3. 决策：
   - ARIA 好 → 写 matchers（确定性方案）
   - ARIA 差 + 高频 → 写 CSS/XPath matchers + fingerprint
   - ARIA 差 + 低频 → 直接用 LLM 提取作为长期方案
4. 编写 workflow + 测试
```

这比"每个站点都手写全套确定性规则"更高效——**低频站点可以永久停在 LLM 提取层，不值得投入人力优化。**

#### ❌ 排除：Graph Pipeline 架构

ScrapeGraphAI 的图管道模型不适合 site-use：
- site-use 的 workflow 天然是线性/分支的（navigate → action → extract），不需要图编排
- 图抽象增加了复杂度但没带来等价灵活性
- 24 种图本质上是线性管道的变体，函数调用链足够

#### ❌ 排除：用 ScrapeGraphAI 作为依赖

不建议将 ScrapeGraphAI 作为 site-use 的运行时依赖：
- Python vs TypeScript 技术栈不匹配
- 图管道过度抽象，只需要其中"清洗 + LLM 提取"这一小块
- 浏览器控制能力远低于 site-use 已有的 Primitives 层
- 自行实现 LLM 提取 fallback 仅需几十行 TypeScript

#### ⏳ 待验证：LLM 提取在真实 Twitter 页面的准确率

第二节的成本估算基于假设。建议在 M1 research spike 中做一次实测：

1. 用 site-use 的浏览器抓取一个真实 Twitter timeline 的 HTML
2. 用 ScrapeGraphAI 的 SmartScraper 提取 50 条推文的结构化数据
3. 与确定性提取的结果对比：字段准确率、遗漏率、延迟、token 消耗
4. 特别关注：时间戳格式、retweet 标记、media 链接等细节字段是否能正确提取

这个实测能直接回答"LLM fallback 在什么精度水平"，决定第 5 层 fallback 的可行性。

#### ⏳ 待验证：HTML 清洗后关键字段的保留率

ScrapeGraphAI 的 `reduce_html(level=2)` 会截断文本节点到 20 字符。对于 Twitter 推文内容（通常 >20 字符），这会丢失正文。需要验证：
- level 0（仅 minify）的 token 削减是否足够
- level 1（属性精简）对提取准确率的影响
- 是否需要定制清洗策略（保留推文正文，裁剪导航/侧边栏）

### 5.4 长期架构判断

**确定性 workflow 路线是正确的主线。** 但随着站点数量增长，需要在架构中为 LLM 辅助留出位置：

| 站点特征 | 推荐提取策略 | 理由 |
|----------|------------|------|
| 高频 + ARIA 好（如 Twitter） | 确定性（ARIA + fingerprint） | 成本低、延迟低、准确率高 |
| 高频 + ARIA 差 | 确定性（CSS/XPath + fingerprint） | LLM 成本随频率线性增长，不划算 |
| 低频 + ARIA 好 | 确定性（ARIA） | 实现简单，维护少 |
| 低频 + ARIA 差 | **LLM 提取** | 手写规则 ROI 低，LLM 零维护 |
| 新站点冷启动 | **LLM 提取 → 逐步迁移** | 先跑通再优化 |
| 所有策略失效 | **LLM 终极 fallback** | 比返回空结果好 |

**不应该向 LLM 驱动方向偏移**——LLM 提取的延迟和成本使其不适合作为主力。但应该把它作为工具箱中的一件工具，在特定场景下发挥作用。
