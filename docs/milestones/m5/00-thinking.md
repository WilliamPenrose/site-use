# M5：探索 → 固化 → 复用

> 状态：早期构思，随时会调整

## 核心问题

M1-M4 的 workflow 都是人类预先编码的。当遇到以下场景时，系统无能为力：

- 新站点（没有预置 workflow）
- 旧站点改版（预置 workflow 失效）
- 用户提出预置 workflow 未覆盖的需求

## 核心循环

```
未知需求
  → agent 用探索原语探索页面
    → 生成 workflow 代码
      → 验证 & 沉淀
        → 未来直接复用
```

M1-M3 中人类手写 Twitter workflow 的过程，本质上就是这个循环的人工版本。M5 要让 agent 自动完成这件事。

## 思路来源

### Anthropic "Building effective agents" 的启发

> 原文：https://www.anthropic.com/research/building-effective-agents

文章区分了 workflow 和 agent 两种模式：

> "We categorize all these variations as **agentic systems**, but draw an important architectural distinction between **workflows** and **agents**:
> - **Workflows** are systems where LLMs and tools are orchestrated through predefined code paths.
> - **Agents**, on the other hand, are systems where LLMs dynamically direct their own processes and tool usage, maintaining control over how they accomplish tasks."

关键原则——能简单就不要复杂：

> "When building applications with LLMs, we recommend finding the simplest solution possible, and only increasing complexity when needed. This might mean not building agentic systems at all."

Agent 适用于无法预定义路径的开放式问题：

> "Agents can be used for open-ended problems where it's difficult or impossible to predict the required number of steps, and where you can't hardcode a fixed path."

**对 M5 的启发**：M5 的核心闭环恰好对应了这两种模式的转换——

- **探索阶段**：agent 模式（动态决策，逐步探索，因为路径未知）
- **固化阶段**：将 agent 探索成果编码为 workflow（预定义代码路径）
- **复用阶段**：workflow 模式（确定性执行，因为路径已知）

### 页面状态导航：通用问题

在实现 Twitter getTimeline 时发现，"确保到达目标页面状态"是所有站点都会面对的问题：

- **URL 型**：导航后检查 URL 即可判断（如 `/home/following`）
- **SPA 型**：URL 不变，需要通过页面状态判断（如 Twitter 的 For You / Following tab，`aria-selected` 属性）

这个问题在 M5 中尤为重要——agent 探索未知站点时，必须能检测和管理页面状态。

### 业界已有的状态导航模式

#### Selenium LoadableComponent — "check-then-load" 幂等导航

> 源码：https://github.com/SeleniumHQ/selenium/wiki/LoadableComponent

最接近的现成方案。核心机制：

```java
public T get() {
    try {
        isLoaded();       // 1. 已在目标状态？
        return (T) this;  //    是 → 直接返回（幂等）
    } catch (Error e) {
        load();           // 2. 不在 → 执行导航
    }
    isLoaded();           // 3. 再次验证
    return (T) this;
}
```

支持链式依赖——子组件的 `load()` 调父组件的 `get()`，形成状态先决条件链。还有 `SlowLoadableComponent` 变体，`load()` 后在 timeout 内轮询 `isLoaded()`，适合异步加载的 SPA。

#### State Objects（ACM Queue 论文）— 同一 URL，多个状态

> 原文：Arie van Deursen, [Beyond Page Objects: Testing Web Applications with State Objects](https://queue.acm.org/detail.cfm?id=2793039), ACM Queue, 2015

Page Object 的进化。核心思路：同一页面的不同状态是不同的对象。transition method 返回新 State Object，类型系统声明合法的状态转换路径。

#### Screenplay Pattern — 状态检测是一等公民

将"当前在哪"（Question 对象）与"要做什么"（Task 对象）分离。状态不是隐式假设的，而是显式查询的。

### Agent 友好的 API 设计研究

#### 发现 1：声明式接口显著优于命令式

> 论文：[A Case for Declarative LLM-friendly Interfaces](https://arxiv.org/abs/2510.04607) (GOI)

论文提出三个声明式原语替代传统命令式 GUI 操作：

> "**Access declaration**: Given a control identifier, GOI deterministically navigates from any current state to that control and performs a primitive interaction (e.g., click)."
>
> "**State declaration**: Given a desired control end state (e.g., scrollbar position; selection state for a control or for text), GOI transitions the control from any current state to the target state, encapsulating compound interactions such as drag and keyboard–mouse coordination."
>
> "**Observation declaration**: Given an information request (e.g., a control's text content), GOI returns structured data rather than relying on pixel-level recognition, and handles any compound interactions needed to reveal hidden content (e.g., expanding a table item)."

核心思想是 policy-mechanism 分离：

> "Our key idea is policy-mechanism separation: LLMs focus on high-level semantic planning (policy) while GOI handles low-level navigation and interaction (mechanism)."

实验结果：

> "In the core setting, GOI yields substantial improvements over the baseline: raising success from 44.4% to 74.1% (1.67×)"
>
> "cutting steps from 8.16 to 4.61 (−43.5%)"
>
> "Notably, GOI completes over 61% of successful tasks with a single LLM call."

注：67% 是相对提升（1.67×），绝对提升为 29.6 个百分点（44.4% → 74.1%）。

#### 发现 2：结构化 API 远优于 GUI 浏览

> 论文：[Beyond Browsing: API-Based Web Agents](https://arxiv.org/abs/2410.16464)

摘要：

> "Hybrid Agents out-perform both others nearly uniformly across tasks, resulting in a more than 24.0% absolute improvement over web browsing alone, achieving a success rate of 38.9%, the SOTA performance among task-agnostic agents."

Table 2 (WebArena 基准)：

| Agents | Gitlab | Map | Shopping | Admin | Reddit | Multi | AVG |
|--------|--------|-----|----------|-------|--------|-------|-----|
| Browsing Agent | 12.8 | 20.2 | 10.2 | 22.0 | 10.4 | 10.4 | **14.8** |
| API-Based Agent | 43.9 | 45.4 | 25.1 | 20.3 | 18.9 | 8.3 | **29.2** |
| Hybrid Agent | 44.4 | 45.9 | 25.7 | 41.2 | 51.9 | 16.7 | **38.9** |

混合 agent 在绝大多数任务中同时使用了两种方式：

> "Table 3 show the frequency of each action type of the Hybrid Agent: it chooses to do both Browsing and API in 77.7% of WebArena tasks, and it shows higher accuracy when choosing API only and API+browsing."

API 质量直接影响性能：

> "For example, Gitlab and Map, with the best API support as mentioned in Section 5.2, demonstrate highest task completion accuracies among websites by the API-Based and Hybrid Agent."

#### 发现 3：工具数量是性能杀手

> 来源：[Speakeasy — Tool Design: Less is More](https://www.speakeasy.com/mcp/tool-design/less-is-more)

注意：以下数据来自 Speakeasy 的实践测试，非学术论文。原文为定性描述，社区流传的精确百分比（"10=100%, 40=75%"）是概括性转述。

107 个工具时：

> "both large and small models struggled to select the correct tools, leading to frequent errors and hallucinations."

20 个工具时：

> "the smaller model got 19 out of 20 tool calls correct, with only one hallucinated tool call."

10 个工具时：

> "the smaller model successfully retrieved images of four different dog breeds with correct tool names and no errors."

临界阈值：

> 大模型（DeepSeek-v3）："30 tools is the critical threshold at which tool descriptions begin to overlap and create confusion."
>
> 小模型（Llama 3.1 8B）："19 tools is the sweet spot at which models succeed at benchmark tasks." / "46 tools is the failure point at which the same models fail the same benchmarks."

Playwright MCP 的佐证（来自同一来源 [Speakeasy blog](https://www.speakeasy.com/blog/playwright-tool-proliferation)，引用 Flask 作者 Armin Ronacher 的观察）：

> "That's only eight of the 26 tools available on the Playwright MCP server."

即 Playwright MCP 的 26 个工具中，实际常用的只有 8 个（navigate, press key, handle dialog, click, type, select, wait for, page snapshot）。

#### 发现 4：上下文效率

> 来源：[Vercel agent-browser](https://github.com/vercel-labs/agent-browser) 及 [第三方分析](https://paddo.dev/blog/agent-browser-context-efficiency/)

官方数据：

> "Text output uses ~200-400 tokens vs ~3000-5000 for full DOM"

"93% 上下文节省"这一数字来自第三方推算，非官方声明：

> "Vercel claims 93% less context than Playwright MCP [...] The number comes from comparing full accessibility tree dumps vs their streamlined reference output. Your mileage varies by page complexity, but the directional improvement is real." — paddo.dev

方向性结论成立：ref ID 定位 + 只返回可交互元素，比 dump 完整 accessibility tree 节省数量级的 token。

#### 发现 5：Schema 防格式但不防语义

> 论文：[Schema First Tool APIs for LLM Agents](https://arxiv.org/abs/2603.13404)

JSON Schema 减少了格式层面的错误，但语义误用反而增加：

> "Relative to prose (A), schema conditions (B/C) show lower average interface misuse (mean invalid calls: A = 5.39, B = 3.72, C = 3.72 over all budgets), consistent with directional support for H1 at the misuse level."
>
> "However, semantic misuse is higher in B/C (A = 0.93, B = 3.03, C = 3.03), indicating that remaining errors are dominated by schema valid but unproductive action choices."

所有条件下任务成功率均为零：

> "Task success was 0.0 across all conditions and all budgets in this pilot."

结论：

> "interface formalization improves contract adherence, but semantic action quality and timeout sensitive tasks remain dominant bottlenecks under constrained local inference."

**启示**：工具描述的"何时不该用"比参数 schema 更重要。

#### 综合影响

| 发现 | 对 M5 的设计约束 |
|------|----------------|
| 声明式 1.67× 成功率 | 探索原语和沉淀的 workflow 都应是声明式接口 |
| API+浏览混合最优 | site-use 的定位（结构化 API + 必要时 UI 操作）方向正确 |
| 工具 > 30 个开始崩溃 | 每站点暴露 ≤ 8 个工具；探索原语控制在 5 个 |
| 上下文效率关键 | observe() 返回精简的语义摘要，不 dump 完整 tree |
| Schema 不防语义错 | 工具描述必须包含"何时不该用"和错误恢复策略 |

### 主流框架的 API 模式

| 模式 | 代表 | 核心思路 | 与 M5 的关系 |
|------|------|---------|-------------|
| 三原子操作 | Stagehand | act / extract / observe | 探索阶段的参考——agent 用类似原语探索未知页面 |
| 全自主循环 | browser-use | LLM 完全控制 | M5 探索阶段的基础模式，但需要有"固化"出口 |
| Snapshot+Refs | Vercel agent-browser | ref ID 定位，大幅节省上下文 | site-use 的 snapshot uid 已对齐这个方向 |
| 声明式目标 | GOI 论文 | 声明期望状态而非操作步骤 | 固化后的 workflow 应提供声明式接口 |
| 步骤机 | ABP | 冻结状态 → 动作 → 冻结 | 探索阶段的每步应有确定性的"settled"状态 |
| 网站侧声明 | WebMCP | 网站用 HTML 属性声明工具 | 未来可作为探索的加速器（如果站点支持） |

## 三层架构

### 关键洞察：agent 不应该直接用 M1 的 Primitives

M1 的 Primitives（navigate, snapshot, click, scroll, evaluate, intercept）是为**人类写 workflow 代码**设计的——命令式、细粒度、需要理解 DOM 结构。调研数据明确表明这对 agent 不友好：

- 低级原语太碎片化 → 步骤多，每步都可能失败
- 工具数量 > 30 → agent 性能开始崩溃（Speakeasy 实测）
- 命令式 vs 声明式 → 成功率差距显著（GOI: 44.4% → 74.1%）

GOI 论文的 policy-mechanism 分离原则直接适用：

> "LLMs focus on high-level semantic planning (policy) while GOI handles low-level navigation and interaction (mechanism)."

**agent 探索时需要一套专属的、更高层的原语。**

### 架构分层

```
┌─────────────────────────────────────────────────┐
│  调用方 agent（Claude、GPT 等）                   │
│  只看到 MCP tools（声明式，每站点 5-8 个）         │
└──────────────┬──────────────────────────────────┘
               │ 已知需求：直接调用
               │ 未知需求：进入探索模式
               ▼
┌─────────────────────────────────────────────────┐
│  Sites 层（sites/twitter/）— 站点特定             │
│  rules, extractors, workflows                    │
│  getTimeline, searchUser, followUser...           │
└──────────────┬──────────────────────────────────┘
               │ 使用
               ▼
┌─────────────────────────────────────────────────┐
│  Ops 层（ops/）— 站点无关的组合操作                │
│                                                   │
│  M2 引入：                                        │
│  ensureState() — 确保到达目标页面状态（幂等）       │
│  matchByRule()  — 语义元素匹配（从 twitter/ 提升）  │
│                                                   │
│  M5 引入：                                        │
│  observe()     — 侦察：页面上有什么？               │
│  act()         — 探索：试探未知控件的交互方式         │
│  extract()     — 读取：按 schema 提取数据            │
│  fill()        — 写入：按 schema 填写表单            │
│                                                   │
│  ※ 所有原语返回统一的 PageState 结构                │
│  ※ 内置反爬保护（M3 throttle + M4 fingerprint）    │
│  ※ 如果 M5 验证了语义级交互，考虑 rename → semantic │
└──────────────┬──────────────────────────────────┘
               │ 实现层
               ▼
┌─────────────────────────────────────────────────┐
│  Primitives 层（primitives/）— 浏览器原子操作      │
│  navigate, snapshot, click, scroll, evaluate,    │
│  intercept, screenshot, type                     │
└──────────────┬──────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────┐
│  Browser 层（browser/）— Chrome 生命周期           │
└─────────────────────────────────────────────────┘
```

依赖方向：`sites → ops → primitives → browser`

### Ops 层的演进

| 里程碑 | ops/ 内容 | 驱动力 |
|--------|----------|-------|
| M2 | `ensureState()` + `matchByRule()` | 4/5 个 workflow 需要状态导航 |
| M5 | + `observe()`, `act()`, `extract()`, `fill()` | agent 探索未知站点 |
| M5 验证后 | 考虑 rename `ops/` → `semantic/` | 证明原语确实工作在语义层面 |

`ops/` 不是为 M5 硬造的层——它在 M2 就有实际价值。M5 只是往里面加东西。

### ensureState 是唯一跨越两个世界的原语

| 原语 | M1-M4 手写 workflow | M5 探索模式 |
|------|---------------------|------------|
| `ensureState()` | **✓ M2 起 4/5 个 workflow 使用** | ✓ 导航 |
| `observe()` | ✗ 一切已知 | ✓ 侦察 |
| `act()` | ✗ 一切已知 | ✓ 试探未知控件 |
| `extract()` | ✗ 有专用 GraphQL 拦截 | ✓ 通用提取 |
| `fill()` | ✗ M1-M4 无表单场景 | ✓ 通用填写 |

### 探索原语的产出是知识，不是可重放的序列

### 探索原语详细设计

#### 五个原语的 2×2 结构 + 探索工具

探索原语有一个清晰的 2×2 矩阵，加上一个探索工具：

```
              读（无副作用）       写（有副作用）
             ─────────────     ─────────────
 导航层       observe()         ensureState()
 载荷层       extract()         fill()

 + act() — 探索未知控件的交互方式（为 fill/ensureState 积累经验）
```

工作流程分三个阶段：**侦察 → 导航 → 载荷**。

```
observe()  →  了解页面结构，为导航决策提供信息
    ↓
ensureState()  →  到达目标状态（URL 导航 / tab 切换 / 筛选框选择...）
    ↓
extract() / fill()  →  到达目标状态后，提取数据 或 填写表单
```

`act()` 的角色：当 `ensureState()` 或 `fill()` 遇到不认识的控件时，agent 用 `act()` 逐步试探交互方式，成功后把模式沉淀回去。

| 原语 | 层 | 作用 | 有副作用？ |
|------|---|------|----------|
| `observe()` | 导航-读 | 返回页面结构：可交互控件、区域、当前状态 | 否 |
| `ensureState()` | 导航-写 | 确保页面到达目标状态（幂等） | 是 |
| `extract()` | 载荷-读 | 按 schema 提取内容数据 | 否 |
| `fill()` | 载荷-写 | 按 schema 填写表单 | 是 |
| `act()` | 探索 | 试探未知控件的交互方式 | 是 |

**关键区分：`observe()` vs `extract()`**

两者都是"看页面"，但语义完全不同：

- `observe()` 看的是**页面结构**（有哪些控件、能做什么） → 服务于导航决策
- `extract()` 看的是**页面内容**（文章、价格、列表数据） → 服务于数据获取

`observe()` 是导航链路的前置步骤，`extract()` 是导航完成后的最终目标。不应合并。

**关键区分：`extract()` vs `fill()`**

两者是对称的载荷操作：

- `extract()` 从页面**批量读取**结构化数据（页面 → agent）
- `fill()` 向页面**批量写入**结构化数据（agent → 页面）

都在到达目标状态之后执行。都是声明式——agent 描述"要读/写什么"，内部处理具体交互。

**关键区分：`act()` vs `fill()` / `ensureState()`**

`act()` 不是 `fill()` 的替代品，而是 `fill()` 的探索模式：

- `fill()` / `ensureState()` 处理**已知的交互模式**（标准控件，交互方式确定）
- `act()` 探索**未知的交互模式**（agent 逐步试探，摸清控件怎么操作）

agent 用 `act()` 摸清一个非标准控件后，交互模式被沉淀到 `fill()` / `ensureState()` 的控件词典里。

| 原语 | 处理已知模式 | 探索未知模式 |
|------|------------|------------|
| `ensureState()` | 已知的页面导航（tab、下拉框...） | — |
| `fill()` | 已知控件的批量写入 | — |
| `extract()` | 已知结构的批量读取 | — |
| `observe()` | — | 探索页面结构 |
| `act()` | — | 探索未知控件的交互方式 |

#### observe() — 侦察

返回页面结构的语义摘要，agent 用它来决定下一步。

```typescript
// 调用
const state = await observe();

// 返回示例
{
  url: 'https://x.com/home',
  tabs: [
    { role: 'tab', name: 'For you', selected: true, ref: '@e3' },
    { role: 'tab', name: 'Following', selected: false, ref: '@e4' },
  ],
  nav: [
    { role: 'link', name: 'Home', ref: '@e1' },
    { role: 'link', name: 'Explore', ref: '@e2' },
  ],
  controls: [
    { role: 'combobox', name: 'Region', value: 'Global', ref: '@e8' },
  ],
  // ...精简的语义摘要，不是完整 accessibility tree
}
```

设计要点（来自 Vercel agent-browser 的经验）：
- 只返回可交互元素的语义信息，不 dump 完整 DOM
- 每个元素附带 ref（= snapshot uid），可直接用于 `act()`
- 官方数据：~200-400 tokens vs ~3000-5000 for full DOM

#### ensureState() — 导航

确保页面到达目标状态。**幂等**——已在目标状态时不做任何操作。

实现借鉴 Selenium LoadableComponent 的 check-then-load 模式：

```
1. 检查 URL → 不匹配 → navigate()
2. 检查页面状态 → 不匹配 → click() 切换
3. 等待 settled（网络请求完成、DOM 稳定）
4. 验证最终状态
```

**target 用结构化描述符表达**，不用自然语言（不需要 LLM 参与，纯确定性）：

```typescript
interface StateDescriptor {
  url?: string | RegExp;       // 页面级：URL 条件
  role?: string;               // 元素级：控件类型
  name?: string | RegExp;      // 元素级：控件名称
  selected?: boolean;          // tab 是否选中
  expanded?: boolean;          // 面板是否展开
  checked?: boolean;           // 复选框/开关是否勾选
  value?: string;              // 下拉框/输入框的值
}
```

为什么是结构化描述符而不是自然语言？

1. **确定性**——不需要 LLM 参与，纯代码执行路径
2. **已有基础**——`SnapshotNode` 本身就是结构化的（role, name, selected, expanded），描述符直接对齐 snapshot 的数据结构
3. **MatcherRule 的自然延伸**——现有代码已经在用 `{ role, name }` 匹配元素，加几个状态字段即可

```typescript
await ensureState({ role: 'tab', name: 'Following', selected: true });
```

这跟 site-use M1 已有的 `MatcherRule`（`{ role, name }` 模式）**同构**——只是扩展了状态条件字段（selected、expanded、value 等）。

支持多种控件类型，交互方式在内部处理，agent 不感知：

| 控件 | role | 状态字段 | 内部交互方式 |
|------|------|---------|-------------|
| Tab | tab | `selected` | click |
| 下拉框 | combobox / listbox | `value` | click → 选选项 |
| 复选框 | checkbox | `checked` | click |
| 折叠面板 | button / region | `expanded` | click |
| 单选按钮 | radio | `checked` | click |
| 开关 | switch | `checked` | click |

支持 URL 导航 + SPA 状态的组合条件：

```typescript
// 纯 URL 导航
ensureState({ url: 'x.com/home' })

// 纯 SPA 状态
ensureState({ role: 'tab', name: 'Following', selected: true })

// 组合：先到 URL，再确保 tab 状态
ensureState({ url: 'x.com/home', role: 'tab', name: 'Following', selected: true })

// 多条件（如 SaaS 筛选）
ensureState([
  { role: 'combobox', name: 'Region', value: 'Asia Pacific' },
  { role: 'combobox', name: 'Date Range', value: 'Last 7 days' },
])
```

**ref 不能用于 ensureState**。ref（= snapshot uid）的生命周期只在单次 snapshot 内有效，`ensureState` 内部会多次 snapshot 来验证状态，之前的 ref 会失效。必须用语义描述符（role + name）来定位元素。

**返回值包含 observe 结果**，agent 不需要在 ensureState 之后再调 observe：

```typescript
const state = await ensureState({ role: 'tab', name: 'Following', selected: true });
// state 已经包含了当前页面的完整结构信息（等同于 observe 的返回值）
// agent 可以直接决定下一步，不需要额外调用
```

#### extract() — 载荷读取

到达目标状态后，按 schema 提取内容数据：

```typescript
const data = await extract({
  schema: {
    title: 'string',
    date: 'string',
    author: 'string',
  },
  list: true,  // 提取列表还是单个
});
```

实现上可能需要比 observe 更重的操作（intercept GraphQL、evaluate JS、滚动加载），但这对 agent 透明。

#### fill() — 载荷写入

到达目标状态后，按 schema 批量填写表单：

```typescript
await fill({
  'Name': 'John',
  'Gender': 'Male',
  'Agree to terms': true,
  'Country': 'Japan',
  'City': 'Tokyo',
}, { submit: true });
```

`fill()` 是 `extract()` 的对称操作——extract 按 schema 批量读，fill 按 schema 批量写。agent 描述"每个字段应该是什么值"，内部处理：

1. 通过 accessible name 定位字段
2. 根据 role 选择交互方式（textbox → type, combobox → click+选选项, checkbox → click）
3. 处理字段间依赖：逐字段填写，每个字段之后等 settled，再处理下一个
4. 可选 submit

**fill() 的能力分级**

| 级别 | 场景 | fill() 能处理？ |
|------|------|----------------|
| L1 | 独立字段（textbox, checkbox） | ✓ role 决定交互方式 |
| L2 | 简单下拉框（click → 选选项） | ✓ 模式固定 |
| L3 | 字段间有依赖（Country → City） | ✓ 逐字段 fill + settled 等待 |
| L4 | 多步向导（step 1 → step 2 → step 3） | 退化为多次 ensureState + fill |
| L5 | 非标准控件（自定义日期选择器、富文本编辑器） | ✗ 需要 act() 探索 |

L5 在 SaaS 产品中非常常见。这正是 `act()` 存在的意义——当 `fill()` 遇到不认识的控件时：

```
fill() 尝试填写 'Date' 字段
  → 识别出 role 不是标准控件（自定义日期选择器）
  → 回退：告诉 agent "Date 字段我不会操作"
  → agent 用 observe() + act() 逐步探索日期选择器的交互方式
  → 探索成功后，交互模式注册到 fill() 的控件词典
  → 下次 fill() 遇到同类控件，直接处理
```

这与 M5 的核心循环（探索 → 固化 → 复用）完全一致。

#### act() — 探索工具

`act()` 用于探索未知控件的交互方式。当 `fill()` 或 `ensureState()` 搞不定某个控件时，agent 降级到 `act()` 逐步试探。

```typescript
// 用 ref（快，来自最近的 observe/ensureState 返回值，同一 snapshot 周期内有效）
await act({ ref: '@e5', action: 'click' })

// 用语义描述符（跨 snapshot 安全）
await act({ role: 'button', name: 'Next Month', action: 'click' })
```

`act()` 是命令式的、逐步的——这是有意的。它的角色就是在未知场景下让 agent 有能力试探，代价是每步回到 LLM 决策。一旦 agent 摸清了交互模式，就应该固化到 `fill()` / `ensureState()` 的控件词典中，后续不再需要逐步 act。

#### 统一返回值

所有五个原语的返回值都包含 **PageState**——当前页面状态的语义摘要。差别只在输入（观察 / 导航 / 交互 / 读取 / 写入），输出统一。agent 拿到任何一个返回值后，都能直接决定下一步，不需要额外调用。

```typescript
interface PageState {
  url: string;
  tabs?: ControlState[];
  nav?: ControlState[];
  controls?: ControlState[];
  content?: any;           // extract 时才有
  settled: boolean;        // 页面是否已稳定
}
```

### 探索原语设计思路

调研中的框架模式直接映射到探索原语的设计：

| 探索原语 | 灵感来源 | 底层实现 | agent 视角 |
|---------|---------|---------|-----------|
| `observe()` | Stagehand observe + Vercel Snapshot+Refs | snapshot + 过滤 + 语义分组 | "这个页面有哪些区域、tab、按钮、表单？" |
| `ensureState(target)` | Selenium LoadableComponent + GOI state declaration | snapshot 检测 + 条件 click + settled 等待 + 验证 | "确保我在 Following tab"（幂等，已在就跳过） |
| `extract(schema)` | Stagehand extract + GOI observation declaration | evaluate + intercept + 清洗 | "提取文章列表，字段是 title/date/author" |
| `fill(data)` | extract 的对称 + GOI state declaration | 字段定位 + role 决定交互 + settled 等待 | "填写表单：Name=John, Country=Japan" |
| `act(intent)` | Stagehand act + GOI access declaration | matcher + click/type/scroll 组合 | 探索未知控件："点这个按钮看看会怎样" |

关键设计原则（来自调研数据）：

1. **5 个探索原语**——工具数量控制在 agent 性能甜点（Speakeasy: 大模型 30 个是临界点，越少越好）
2. **2×2 + 探索**——导航层（observe/ensureState）+ 载荷层（extract/fill）+ 探索工具（act），职责清晰
3. **声明式接口**——agent 说"要什么"，不说"怎么做"（GOI: policy-mechanism 分离）
4. **返回值自带状态**——每次调用返回 PageState，省掉验证循环（Beyond Browsing: 混合方案最优）
5. **内置反爬**——throttle、指纹保护在探索原语内部自动生效，agent 不感知
6. **settled 语义**——每个原语返回时，页面已稳定（借鉴 ABP 步骤机）
7. **探索产出是知识，不是可重放序列**——探索原语帮 agent 理解页面，agent 基于知识生成 M1 Primitives 代码作为 workflow

### 探索原语的产出是知识，不是可重放的序列

以 getTimeline 为例验证：假设领域知识已知，能否用探索原语实现 getTimeline？

```
ensureState({ url: 'x.com/home', role: 'tab', name: 'Following', selected: true })
extract({ schema: tweetSchema, list: true, count: 20 })
```

**做不到。** getTimeline 的核心逻辑包含：

1. **时序约束**——GraphQL 拦截必须在导航之前设置（`interceptRequest` → `navigate`）
2. **滚动循环**——带 stale detection 的滚动采集（`while + scroll + wait`）
3. **网络层操作**——拦截特定 URL pattern 的响应并解析
4. **后处理**——广告过滤、URL 展开、HTML 实体解码

这些都是**编排逻辑**——有时序、有循环、有条件判断。探索原语是声明式的，表达不了这些。

**关键认知修正：固化出来的 workflow 用的是 M1 Primitives，不是探索原语。**

```
探索原语 → agent 获取知识（页面结构、数据源、交互模式、时序约束）
                ↓
         agent 生成 workflow 代码
                ↓
M1 Primitives → workflow 确定性执行（interceptRequest, navigate, scroll, evaluate...）
```

探索原语和 M1 Primitives 服务不同的对象：

| | 探索原语 | M1 Primitives |
|---|---------|---------------|
| **服务谁** | Agent（发现该做什么） | Workflow 代码（确定性执行） |
| **表达力** | 声明式，简单，无控制流 | 命令式，完整控制流 |
| **产出** | 知识（页面结构、数据源、交互模式） | 执行结果 |
| **能实现 getTimeline？** | 不能 | 能 |

探索原语的价值不是"可重放"，而是让 agent 获取足够的知识来**编写** workflow 代码。

### 已知 workflow vs 探索原语的关系

```
确定性程度高 ←————————————————→ 确定性程度低

已知 workflow（M1-M4）             探索原语（M5）
getTimeline({ feed })            observe() → ensureState() → act() → ...

✓ 站点结构已知                     ✗ 站点结构未知
✓ 操作路径固定                     ✗ 路径需要试探
✓ 失败模式可枚举                   ✗ 失败模式不可预测
✓ 一次调用完成                     ✗ 多步交互探索
✓ 接近 100% 可靠                   ✗ 依赖 LLM 推理质量
✓ M1 Primitives 实现              ✗ 探索原语实现
```

**探索成功后，agent 用获取的知识编写 M1 Primitives 代码，固化为 workflow。**

### 完整探索示例

#### 示例 1：agent 探索 Twitter timeline（知识获取过程）

```
用户需求："帮我看看 Twitter Following 上在聊什么"
无预置 workflow，agent 进入探索模式。

1. ensureState({ url: 'x.com/home' })
   → agent 获得知识：Twitter 首页 URL

2. observe()
   → agent 获得知识：有 For you / Following 两个 tab

3. ensureState({ role: 'tab', name: 'Following', selected: true })
   → agent 获得知识：Following tab 通过 ARIA role=tab 定位

4. extract({ schema: { author: 'string', text: 'string' }, list: true })
   → agent 获得知识：能从 DOM 提取到基础 tweet 数据
   → 但质量不高（缺少 metrics、media、t.co 未展开）

5. inspect()（网络层观察，待设计）
   → agent 获得知识：页面在加载时请求了 /i/api/graphql/.../HomeTimeline
   → GraphQL 响应包含完整的 tweet 结构（含 metrics、media、entities）
   → 关键发现：GraphQL 是更好的数据源

6. agent 基于以上知识，生成 workflow 代码：
   → 用 interceptRequest 在 navigate 之前拦截 GraphQL
   → 用 scroll 循环 + stale detection 加载更多
   → 用 parseGraphQLTimeline 解析响应
   → 过滤广告、展开 URL、截断到 count
   → 本质上生成了当前手写的 getTimeline
```

步骤 1-5 的探索原语调用不会被"重放"——它们的作用是让 agent 理解 Twitter 的页面结构和数据流。步骤 6 生成的 workflow 代码才是被固化和复用的。

#### 示例 2：从未知新闻站点提取文章（简单场景）

```
1. observe()
   → 知识：有分类 tab（Tech/Business/Sports）

2. ensureState({ role: 'tab', name: 'Tech', selected: true })
   → 知识：tab 通过 role=tab + selected 切换

3. extract({ schema: { title: 'string', date: 'string', author: 'string' }, list: true })
   → 知识：DOM 提取即可满足需求（无需 GraphQL）

4. agent 生成 workflow 代码：
   → ensureState + DOM extract 即可（简单场景可能直接复用探索原语调用序列）
```

注意：简单场景下，生成的 workflow **可能**就是探索原语的调用序列。但复杂场景（如 getTimeline）一定会退化到 M1 Primitives。

#### 示例 3：在 SaaS 平台创建工单（表单写入）

```
1. observe()
   → 知识：有 "New Ticket" 按钮

2. ensureState({ url: '/tickets/new' })
   → 知识：工单创建页 URL

3. fill({
     'Title': 'Login page broken',
     'Priority': 'High',
     'Category': 'Bug',
     'Description': 'Users cannot login since 2pm',
   }, { submit: true })
   → 知识：表单字段名称、控件类型、有无依赖关系
```

#### 示例 4：遇到非标准控件（fill 降级到 act 探索）

```
1. fill({ 'Date': '2026-04-01' })
   → fill() 发现 Date 是自定义日期选择器，返回 "unknown control"

2. observe()  → 知识：Date 字段旁有日历图标按钮
3. act({ role: 'button', name: 'Open calendar', action: 'click' })  → 弹出日历面板
4. observe()  → 知识：有月份导航箭头和日期格子
5. act({ role: 'button', name: 'Next month', action: 'click' })  → 切到 4 月
6. act({ role: 'gridcell', name: '1', action: 'click' })  → 选中 4 月 1 日

7. agent 获得了日期选择器的交互知识 → 生成 workflow 代码：
   → 计算目标月份与当前月份的差值
   → 循环点击 next/prev 月份按钮
   → 点击目标日期格子
   → 这是一段有控制流的代码，不是简单的 act 序列
```

## 开放问题

### 探索原语的边界

- `observe()` 返回什么粒度的信息？完整 accessibility tree 太大（上下文爆炸），只返回可交互元素又可能丢失语义上下文
- `act()` 是否需要 LLM 参与？（Stagehand 的 act 内部调 LLM 做元素定位）还是纯确定性？
- 探索原语是否需要"撤销"能力？（agent 走错路时能回退）
- 是否需要 `inspect()` 原语来观察网络层？（agent 发现 GraphQL 等 API 端点的能力）

### 固化阶段

- agent 生成的 workflow 代码用 M1 Primitives 编写——agent 需要理解 interceptRequest、scroll 等底层原语的语义才能生成正确代码，这对 agent 的编码能力要求很高
- 简单场景的 workflow 可能就是探索原语调用序列，复杂场景必须退化到 M1 Primitives——是否需要分级处理？
- 如何验证生成的 workflow 是正确的？跑一次成功够吗？
- workflow 的版本管理——站点改版后如何知道 workflow 过期了？

### 复用阶段

- 沉淀的 workflow 存在哪里？文件系统？数据库？
- 如何自动注册为 MCP tool？
- 如何匹配"这个需求可以用已有的 workflow"？（语义匹配？关键词？）

### 与 M4 的关系

- M4（Fingerprint + CompositeMatcher）提供了元素定位的韧性——agent 探索时也需要这个能力
- M4 的"ARIA 失败 → 指纹 fallback"是 M5 的一个子场景——M5 处理的是"整个 workflow 不存在"而不仅仅是"某个元素找不到"
- M4 是 M5 的基础设施之一

## 参考资料

| 来源 | 类型 | 关键贡献 |
|------|------|---------|
| [Building effective agents](https://www.anthropic.com/research/building-effective-agents) | Anthropic 博文 | workflow vs agent 定义；能简单就不要复杂 |
| [GOI: Declarative LLM-friendly Interfaces](https://arxiv.org/abs/2510.04607) | 论文 | 声明式原语；policy-mechanism 分离；44.4% → 74.1% 成功率 |
| [Beyond Browsing: API-Based Web Agents](https://arxiv.org/abs/2410.16464) | 论文 | API 29.2% vs GUI 14.8% vs 混合 38.9%（WebArena） |
| [Schema First Tool APIs](https://arxiv.org/abs/2603.13404) | 论文 | Schema 防格式不防语义；工具描述 > 参数定义 |
| [Speakeasy: Tool Design Less is More](https://www.speakeasy.com/mcp/tool-design/less-is-more) | 实践测试 | 工具数量临界点（大模型 ~30，小模型 ~19） |
| [Selenium LoadableComponent](https://github.com/SeleniumHQ/selenium/wiki/LoadableComponent) | 框架源码 | check-then-load 幂等导航；链式依赖 |
| [State Objects (ACM Queue)](https://queue.acm.org/detail.cfm?id=2793039) | 论文 | 同一 URL 多状态；状态转换类型化 |
| [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) | 开源项目 | Snapshot+Refs；~200-400 tokens vs ~3000-5000 for full DOM |
| 详细调研笔记 | 知识库 | `d:\src\knowledge\browser-use\agent-api-design-research.md` |
