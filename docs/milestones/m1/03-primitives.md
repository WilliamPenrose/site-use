# 能力 2：Primitives 层 — 浏览器操作原语

> 上游文档：[技术架构设计](../../site-use-design.md) — Primitives 层章节，[M1 里程碑](../overview.md) — 能力 2
> 状态：待讨论

## 目标

提供统一的浏览器操作接口，站点适配层通过 Primitives 操作浏览器，不直接调用 Puppeteer。接口语义对齐 chrome-devtools-mcp，确保未来可切换后端。

## 为什么需要 Primitives 层

### 为什么站点层不直接调 Puppeteer

如果 Twitter workflows 直接 `import puppeteer` 调 `page.click('.follow-btn')`，会产生两个问题：

1. **无法切换底层**：未来如果用户已经跑了 devtools-mcp 服务，我们想用一个 MCP client 适配器（`devtools-mcp-backend.ts`）替换 Puppeteer 直连。如果 workflow 里散布着 Puppeteer API 调用，就无法替换
2. **throttle 无处安放**：操作节奏控制（随机延迟、渐进滚动）需要包在每个浏览器操作外面。如果 workflow 直接调 Puppeteer，throttle 逻辑要散布在每个 workflow 里。有了 Primitives 层，throttle 作为装饰器统一包装，workflow 完全不感知

### 为什么对齐 devtools-mcp 接口

不是为了"好看"，是为了**降低设计成本和验证成本**：

1. **设计疑问有权威答案**：`takeSnapshot()` 返回什么格式？`click(uid)` 内部怎么定位元素？这些问题 devtools-mcp 已经回答了，我们照搬语义即可
2. **验证有参照物**：我们的 `takeSnapshot()` 行为是否正确，可以与 devtools-mcp 的输出做对比
3. **未来切换零成本**：如果写一个 `devtools-mcp-backend.ts`，只需要把接口调用翻译为 MCP tool call，上层零改动

### 为什么 M1 定义全部 8 个原语但只实现 7 个

接口定义成本极低（只是类型签名），但如果 M1 只定义 7 个，M2 加原语时就要修改接口文件——而接口文件是被所有 backend 和所有 workflow 依赖的。提前定义完整接口，M2 只需要在 backend 里加实现，**依赖链上不需要任何文件修改**。

> 原计划实现 6/8，research spike（2026-03-19）确认 GraphQL 拦截为 Twitter 主力提取策略，`interceptRequest` 提前到 M1。

---

## 文件

| 文件 | 职责 |
|------|------|
| `src/primitives/types.ts` | 接口定义（全部 8 个原语的类型签名） |
| `src/primitives/puppeteer-backend.ts` | Puppeteer 实现 + 多页面管理（M1 实现 7/8） |
| `src/primitives/throttle.ts` | 节流包装器 |

---

## 子模块 A：types.ts — 接口定义

### 设计原则

- 定义**全部 8 个原语**的类型签名，M1 实现 7 个，仅 `type` 在 backend 中抛 `NotImplemented`
- 命名、参数、返回值语义对齐 devtools-mcp，有疑问直接参考 devtools-mcp 源码
- 这个文件 M1 之后不再修改（M2 只加实现，不改接口）

### Primitives 接口

| 原语 | 对齐 devtools-mcp | M1 实现 | 说明 |
|------|-------------------|---------|------|
| `navigate(url)` | `navigate_page` | ✅ | 导航 + 等待加载 |
| `takeSnapshot()` | `take_snapshot` | ✅ | 获取辅助功能树 JSON |
| `click(uid)` | `click` | ✅ | 通过 snapshot uid 点击 |
| `scroll(options)` | `scroll` | ✅ | 滚动页面 |
| `evaluate(fn)` | `evaluate_script` | ✅ | 执行 JS 表达式 |
| `screenshot()` | `screenshot` | ✅ | 截图，返回 base64 PNG |
| `type(uid, text)` | `type` | ❌→M2 | M1 无文本输入需求 |
| `interceptRequest(pattern, handler)` | — | ✅ | Research spike 结论：GraphQL 拦截为 Twitter 主力提取策略 |

### 核心数据类型

**SnapshotNode** — 辅助功能树中的一个节点：

```typescript
{
  uid: string       // 本次 snapshot 内的唯一标识
  role: string      // ARIA role（button, link, textbox, article 等）
  name: string      // 无障碍名称
  value?: string    // 表单元素的值
  children?: string[] // 子节点 uid 列表
  // 可选属性：focused, disabled, expanded, selected, level
}
```

**Snapshot** — `takeSnapshot()` 的返回值：

```typescript
{
  idToNode: Map<string, SnapshotNode>  // uid → node 的 O(1) 查找表
}
```

### Escape Hatch

```typescript
getRawPage(site?: string): Promise<Page>
```

少数情况下 Primitives 接口无法覆盖（如 `page.authenticate()` 设置代理认证），站点层可以通过 escape hatch 拿到底层 Puppeteer Page。这是例外不是常态（详见[技术架构设计 — 模块边界原则](../../site-use-design.md)）。

**为什么提供 escape hatch 而不是不断扩展 Primitives 接口**：Primitives 接口对齐 devtools-mcp 的工具定义，保持精简。如果为每个偶发需求（如代理认证、cookie 操作、特殊事件监听）都加原语，接口会膨胀失控。escape hatch 承认"抽象不可能覆盖所有场景"，但把它限制在已知的少数入口，而不是让 workflow 到处 import Puppeteer。

### 与 Extractor 接口的关系

Primitives 接口的设计直接支撑了 extractors 的架构预留 R1（[技术架构设计 — LLM 兜底路径架构预留](../../site-use-design.md)）：extractor 对 workflow 暴露统一签名，workflow 不关心内部用了哪个 Primitives 原语（`evaluate` 还是 `interceptRequest`）。这要求 Primitives 接口保持稳定——M1 定义全部 8 个原语类型正是为此。

---

## 子模块 B：puppeteer-backend.ts — Puppeteer 实现

### 核心技术点

这是 M1 中技术复杂度最高的部分。核心挑战是 `takeSnapshot()` → uid 映射 → `click(uid)` 链路。

**为什么用辅助功能树 uid 而不是 CSS 选择器定位元素**：

这是架构设计文档中的核心决策，但值得在实现层面重新解释。CSS 选择器（如 `.css-abc123`）直接依赖 DOM class name，Twitter 每次构建都可能变化。辅助功能树的 role + name（如 `button "Follow"`）是语义级别的标识——改变它们会破坏 Twitter 自身的无障碍合规性，所以远比 CSS 类名稳定。

devtools-mcp 的实践验证了这条路径的可行性：它在所有 Chrome 页面上用辅助功能树做元素定位，包括复杂的 SPA。site-use 不需要从头发明，只需对齐这套成熟机制。

#### takeSnapshot() 实现路径

对齐 devtools-mcp 的实现：

```
CDP Accessibility.getFullAXTree
    → 遍历 AX 节点数组
    → 跳过 ignored / role=none 的节点
    → 为每个有效节点分配递增 uid
    → 记录 uid → backendDOMNodeId 映射（内部状态）
    → 构建 idToNode Map 返回给调用方
```

**关键细节**：
- AX 节点的 `backendDOMNodeId` 是后续 `click(uid)` 定位元素的桥梁
- uid 是快照作用域内的临时标识，每次 `takeSnapshot()` 重新分配
- `idToNode` 是公开返回值，`uid → backendDOMNodeId` 是内部状态

#### click(uid) 实现路径

```
查找 uid 对应的 backendDOMNodeId
    → CDP DOM.getBoxModel({ backendNodeId }) 获取元素位置
    → 计算中心坐标
    → page.mouse.click(x, y) 触发完整鼠标事件序列
    → 等待 DOM 稳定（MutationObserver，100ms 无变化 或 3s 超时）
```

**为什么用坐标点击而不是 DOM 引用**：
- `page.mouse.click(x, y)` 生成完整事件链（mousemove → mousedown → mouseup → click），与真人行为一致
- 通过 CDP DOM 操作直接触发的 click 只有 click 事件，缺少鼠标移动，容易被反爬检测

#### evaluate() 实现

直接调用 `page.evaluate()`。传入的是字符串表达式（不是函数引用），在浏览器 context 中执行。

**为什么传字符串而不是函数引用**：Puppeteer 的 `page.evaluate()` 支持传函数，但函数会被序列化为字符串再传到浏览器 context。传字符串是显式的——让调用方清楚"这段代码运行在浏览器里，不能闭包引用 Node.js 变量"，减少犯错机会。此外，对齐 devtools-mcp 的 `evaluate_script`，它接收的也是字符串表达式。

**与 snapshot/click 的混合使用规则**：
- `evaluate()` 走 CDP Runtime 域，`click()` 走 Accessibility/DOM/Input 域，两者通过不同 CDP 路径通信，互不干扰
- 只读的 `evaluate()` 不修改 DOM，不会使 uid 失效
- 如果 `evaluate()` 修改了 DOM，则之前的 uid 可能失效，需要重新 `takeSnapshot()`
- 典型的安全组合顺序：`evaluate`（读数据做决策）→ `takeSnapshot`（获取最新状态）→ `click(uid)`（操作）

#### scroll() 实现

- 渐进式滚动：分 N 步完成，每步之间有短延迟，避免瞬间跳到底部
- 滚动后等待 500ms，给 lazy-loaded 内容加载时间

#### navigate() 实现

- `page.goto(url, { waitUntil: 'load' })`
- 30s 超时

#### screenshot() 实现

- `page.screenshot({ encoding: 'base64' })`
- 返回 base64 PNG 字符串

### 多页面管理

```
PuppeteerBackend 内部状态：
  pages: Map<string, Page>   // site 名称 → Puppeteer Page
  currentSite: string        // 当前活跃的 site

调用原语时：
  getPage(site?) → pages.get(site) ?? 新建 page 并缓存
```

- **Lazy 创建**：第一次调某个 site 的原语时 `browser.newPage()` 并缓存
- **自动路由**：workflow 通过 site 参数拿到对应的 page
- **M1 只有一个 entry**：`'twitter'`。结构支持未来加更多站点

**为什么不用 devtools-mcp 那套完整的 Context Layer**：devtools-mcp 有 McpContext → McpPage → PageCollector 三层抽象，支持通用的 page ID 切换（create/switch/close）和事件收集。site-use 的 workflow 知道自己操作哪个站点，不需要通用 page 切换；也不需要 PageCollector 收集网络/控制台事件。一个简单的 `Map<site, Page>` 就够了，少一层抽象意味着少一层要维护和调试的代码。

**为什么每个站点固定一个 tab 而不是按需创建销毁**：保持 tab 打开意味着登录态、滚动位置、已加载的内容都不丢失。如果每次操作都 newPage + 关掉，用户每次调 `twitter_timeline` 都要重新导航和等待页面加载。

### 需要验证的技术风险

| 风险 | 验证方法 |
|------|---------|
| CDP `Accessibility.getFullAXTree` 返回的节点结构是否包含 `backendDOMNodeId` | 在真实 Twitter 页面上调 CDP 命令检查 |
| `DOM.getBoxModel` 对辅助功能树中的节点是否都能返回坐标 | 隐藏元素、viewport 外元素可能没有 box model |
| 每次调用 `takeSnapshot()` 创建和销毁 CDP session 是否有性能问题 | 对比 devtools-mcp 的 session 复用策略 |

---

## 子模块 C：throttle.ts — 节流包装

### 设计

装饰器模式：接受一个 `Primitives` 实例，返回一个新的 `Primitives` 实例，在每个操作前插入随机延迟。

**为什么用装饰器而不是在每个原语内部加延迟**：

1. **关注点分离**：puppeteer-backend 只负责"正确地执行操作"，throttle 只负责"控制操作节奏"。两者独立变化——M3 增强 throttle 策略时不需要碰 backend 代码
2. **可测试**：单元测试 throttle 时 mock 一个 inner Primitives，验证延迟行为。单元测试 backend 时（如果有）不受 throttle 干扰
3. **可替换**：开发/调试时传 `{ minDelay: 0, maxDelay: 0 }` 禁用节流，加快迭代速度
4. **未来后端切换**：如果换成 devtools-mcp-backend，throttle 包装不变，新后端也自动有节奏保护

```
ThrottledPrimitives(inner: Primitives, config?: ThrottleConfig)
```

### 节流配置

```typescript
{
  minDelay: number  // 最小延迟 ms，默认 1000
  maxDelay: number  // 最大延迟 ms，默认 3000
}
```

站点适配层可以覆盖默认配置。

### 豁免操作

以下操作不经过节流（只读/工具性质）：
- `screenshot()` — 调试用，需要即时响应
- `getRawPage()` — 获取引用，不触发浏览器操作

### 对未来的支持

M3 增强 throttle 内部策略（点击坐标抖动 ±3px、渐进滚动、站点级频率上限），但 `ThrottledPrimitives` 的包装方式和接口不变。workflow 层不感知 throttle 内部策略的变化。

---

## 组装方式

各层组装在 MCP Server 中（详见 04-mcp-server.md）：

```
ensureBrowser()
    → new PuppeteerBackend(browser)
        → new ThrottledPrimitives(backend)
            → 传给 workflows
```

---

## 测试策略

| 子模块 | 测试方式 |
|--------|---------|
| types.ts | 纯类型，不需要运行时测试 |
| puppeteer-backend.ts | 需要真实 Chrome，手动集成测试 |
| throttle.ts | mock inner primitives，单元测试（验证延迟行为和豁免操作） |

---

## 对未来的支持

| 决策 | 为什么不会返工 |
|------|--------------|
| types.ts 定义全部 8 个原语 | M2 只加实现，接口不改 |
| `Map<site, Page>` 多页面结构 | 未来站点只加 entry |
| Throttle 包装方式 | M3 增强内部策略，包装模式不变 |
| `getRawPage()` escape hatch | 特殊情况有出路，不需要强行扩展 Primitives 接口 |
| CDP session 策略 | 如果验证发现性能问题，可以改为复用 session，上层接口不变 |
