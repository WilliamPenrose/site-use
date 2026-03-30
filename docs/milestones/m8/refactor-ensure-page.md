# 重构：提取 ensurePage 通用范式

> 状态：已实施
> 日期：2026-03-30

## 问题

[workflows.ts](../../../src/sites/twitter/workflows.ts) 中有三个 ensure 函数：

- `ensureTimeline`（第 79–149 行）
- `ensureTweetDetail`（第 160–212 行）
- `ensureSearch`（第 223–279 行）

它们共享同一个骨架：导航 → 可选的后置钩子 → 等待拦截到数据 → 超时则 reload 重试。三个函数各自在闭包里定义了一模一样的 `timedWait` 辅助函数（6 行 × 3 = 18 行纯复制）。

### 为什么这是个问题

**1. 新站点成本高。** 当前只有 Twitter 一个站点。当要加第二个站点（XHS、Reddit……）时，开发者必须从 `ensureTimeline` 里逆向理解哪些是 Twitter 专属逻辑、哪些是通用范式。没有文档化的脚手架，只能靠复制粘贴再删改——这正是 `ensureSearch` 诞生的方式（从 `ensureTweetDetail` 复制而来）。

**2. Bug 修一处漏两处。** 三个函数的 reload 兜底逻辑几乎相同，但因为是独立实现，未来修改等待策略或 tracing 行为时必须同步改三处。目前只有 3 个函数还可以手动对齐，但随着站点增多，这个 N×M 的维护成本不可接受。

**3. 关键行为没有独立测试。** `timedWait` 的超时/唤醒语义、reload 兜底的触发条件，这些行为隐藏在三个大函数里，无法被单独测试。提取后可以对通用骨架写单元测试，各站点只测自己的配置。

### 为什么现在做

设计文档（[site-use-design.md](../../site-use-design.md)）明确写道：

> 做完 2-3 个站点后再提炼声明式引擎

现在 Twitter 站点已经有 3 个完整 workflow（timeline、tweet-detail、search），它们就是"2-3 个站点"的微缩版——同一个站点内的 3 种 GraphQL 端点已经暴露了足够的模式差异。再等第二个站点才提炼，只会让新站点带着复制粘贴的技术债上线。

---

## 当前结构分析

把三个函数拆成步骤，标注相同/不同：

| 步骤 | ensureTimeline | ensureTweetDetail | ensureSearch | 相同？ |
|------|---------------|-------------------|--------------|--------|
| 定义 `timedWait` | 6 行 | 6 行 | 6 行 | **完全相同** |
| 构造目标 URL | 固定 `TWITTER_HOME` | 传入 `opts.url` | 拼接 `searchUrl` | 不同 |
| 导航 | `ensure({url})` + 强制 re-nav | `navigate(url)` | `navigate(url)` | 不同 |
| 导航后钩子 | 切 tab + 清理数据 | 检测登录重定向 | 检测登录重定向 | 不同 |
| 等待初始数据 | `timedWait('initial_data', ...)` | 同左 | 同左 | **完全相同** |
| 超时 reload 兜底 | `navigate(HOME)` + 切回 tab | `navigate(url)` | `navigate(url)` | 骨架相同，<br>重导航目标不同 |
| 再次等待 | `timedWait('after_reload', ...)` | 同左 | 同左 | **完全相同** |

**结论：** ~60% 完全相同，~30% 可参数化，~10% 真正独特（ensureTimeline 的 tab 切换含数据清理）。

---

## 设计

### 核心思路

提取一个 `ensurePage<T>` 函数，封装「导航 → 等数据 → reload 兜底」的通用骨架。站点通过 `EnsurePageConfig` 注入差异点：怎么导航、导航后做什么、reload 后做什么。

### 为什么放在 `src/sites/twitter/` 而不是 `src/ops/`

`ops/` 层现有三个模块（`data-collector`、`ensure-state`、`matchers`）都是**单步原语**——做一件事，返回结果，调用者自由组合。`ensurePage` 是"用原语编排出的多步流程"（导航 + 钩子 + 等待 + 重试），复杂度和职责粒度明显高于 ops 层。

如果把它放进 `ops/`，就打破了 ops 层"原子积木"的抽象边界。后续 Phase 3 的 `defineWorkflow` 也会以同样理由下沉到 `ops/`，最终 ops 退化成"什么都有层"。

因此 `ensurePage` 留在 `src/sites/twitter/ensure-page.ts`。当第二个站点确认需要相同骨架时，再将其上提到一个合适的共享层（可能是新的 `src/workflow/` 而非 `ops/`）——那时候有两个数据点，归属选择更有把握。

### 为什么是配置对象而不是基类

1. **组合优于继承。** 站点的 ensure 逻辑是"一个骨架 + 几个钩子"，不是"一棵继承树"。配置对象让每个调用点的差异一目了然。
2. **与现有模式一致。** 项目里 `createDataCollector`、`makeEnsureState` 都是工厂函数 + 配置，不是 class。保持风格统一。
3. **可测试性。** 配置对象可以 mock 每个钩子独立测试，基类做不到这种粒度。

### 为什么 `timedWait` 不独立导出

`timedWait` 的签名依赖 `collector`、`waits` 数组、`t0` 三个闭包变量。如果独立导出，调用者就要传 4 个参数，比闭包更冗长。把它封装在 `ensurePage` 内部是最自然的归属——它本来就是这个骨架的内部细节。

### 接口设计

```typescript
// src/sites/twitter/ensure-page.ts

export interface EnsurePageConfig<T> {
  /** 接收拦截数据的 collector */
  collector: DataCollector<T>;
  /** 计时基准 */
  t0: number;
  /** 导航到目标页面 */
  navigate: (primitives: Primitives) => Promise<void>;
  /** 导航后钩子：登录检测、tab 切换等（可选） */
  afterNavigate?: (primitives: Primitives, span: SpanHandle) => Promise<void>;
  /** reload 后额外步骤：重新切 tab 等（可选） */
  afterReload?: (primitives: Primitives) => Promise<void>;
  /** 等待超时（默认 3000ms） */
  waitMs?: number;
  /** 日志前缀 */
  label: string;
}

export interface EnsurePageResult {
  reloaded: boolean;
  waits: WaitRecord[];
}

export async function ensurePage<T>(
  primitives: Primitives,
  config: EnsurePageConfig<T>,
  span: SpanHandle = NOOP_SPAN,
): Promise<EnsurePageResult> {
  const { collector, t0, waitMs = 3000, label } = config;
  const waits: WaitRecord[] = [];
  let reloaded = false;

  async function timedWait(purpose: string, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now() - t0;
    const satisfied = await collector.waitUntil(predicate, timeoutMs);
    waits.push({ purpose, startedAt, resolvedAt: Date.now() - t0, satisfied, dataCount: collector.length });
    return satisfied;
  }

  // Step 1: Navigate
  console.error(`[site-use] ${label}: navigating...`);
  await span.span('navigate', () => config.navigate(primitives));

  // Step 2: Post-navigation hook
  if (config.afterNavigate) {
    await span.span('afterNavigate', (s) => config.afterNavigate!(primitives, s));
  }

  // Step 3: Wait for data + reload fallback
  await span.span('waitForData', async (s) => {
    const hasData = await timedWait('initial_data', () => collector.length > 0, waitMs);
    s.set('satisfied', hasData);
    s.set('dataCount', collector.length);

    if (!hasData && !reloaded) {
      console.error(`[site-use] ${label}: no data, reloading...`);
      reloaded = true;
      collector.clear();
      await config.navigate(primitives);
      if (config.afterReload) await config.afterReload(primitives);
      const ok = await timedWait('after_reload', () => collector.length > 0, waitMs);
      s.set('reloaded', true);
      s.set('satisfiedAfterReload', ok);
      s.set('dataCountAfterReload', collector.length);
    }
  });

  return { reloaded, waits };
}
```

### 调用点变化

**ensureTweetDetail — 变为纯配置（无自定义逻辑）**

```typescript
export async function ensureTweetDetail(primitives, collector, opts, span) {
  return ensurePage(primitives, {
    collector, t0: opts.t0,
    label: 'tweet-detail',
    navigate: (p) => p.navigate(opts.url),
    afterNavigate: (p, s) => checkLoginRedirect(p, s),
  }, span);
}
```

**ensureSearch — 同样是纯配置**

```typescript
export async function ensureSearch(primitives, collector, opts, span) {
  const tabParam = opts.tab === 'latest' ? '&f=live' : '';
  const searchUrl = `https://x.com/search?q=${encodeURIComponent(opts.query)}&src=typed_query${tabParam}`;
  return ensurePage(primitives, {
    collector, t0: opts.t0,
    label: `search/${opts.query}`,
    navigate: (p) => p.navigate(searchUrl),
    afterNavigate: (p, s) => checkLoginRedirect(p, s),
  }, span);
}
```

**ensureTimeline — 保留 tab 切换作为 afterNavigate 钩子**

```typescript
export async function ensureTimeline(primitives, collector, opts, span) {
  const ensure = makeEnsureState(primitives);
  const tabName = opts.tab === 'following' ? 'Following' : 'For you';
  let navAction: 'already_there' | 'transitioned' = 'already_there';
  let tabAction: 'already_there' | 'transitioned' = 'already_there';

  const result = await ensurePage(primitives, {
    collector, t0: opts.t0,
    label: `timeline/${tabName}`,
    navigate: async (p) => {
      const navResult = await ensure({ url: TWITTER_HOME });
      navAction = navResult.action;
      // only force re-nav when already on the page — ensure() already
      // navigates when URL doesn't match (transitioned), so a second
      // navigate would be redundant and waste a page load
      if (navResult.action === 'already_there') {
        await p.navigate(TWITTER_HOME);
      }
    },
    afterNavigate: async (p, s) => {
      // tab 切换 + 数据清理——timeline 独有的逻辑
      const prevLength = collector.length;
      const tabResult = await ensure({ role: 'tab', name: tabName, selected: true });
      tabAction = tabResult.action;
      if (tabAction !== 'already_there') {
        const dataFromSwitch = collector.items.slice(prevLength);
        collector.clear();
        if (dataFromSwitch.length > 0) collector.push(...dataFromSwitch);
      }
    },
    afterReload: async () => {
      await ensure({ role: 'tab', name: tabName, selected: true });
    },
  }, span);

  return { navAction, tabAction, ...result };
}
```

**`checkLoginRedirect` — 从两处复制变为一个共享函数**

留在 `src/sites/twitter/workflows.ts` 内部（非导出）——URL 模式 `/login`、`/i/flow/login` 是 Twitter 特有的，不属于 `ops/` 层。

```typescript
async function checkLoginRedirect(primitives: Primitives, span: SpanHandle = NOOP_SPAN): Promise<void> {
  await span.span('checkLogin', async (s) => {
    const url = await primitives.evaluate<string>('window.location.href');
    s.set('currentUrl', url);
    if (url.includes('/login') || url.includes('/i/flow/login')) {
      throw new SiteUseError('SessionExpired', 'Not logged in — redirected to login page',
        { retryable: false });
    }
  });
}
```

调用点传入 span 以保留 tracing 信息：

```typescript
afterNavigate: (p, s) => checkLoginRedirect(p, s),
```

### 文件变更范围

| 文件 | 变更 |
|------|------|
| `src/sites/twitter/ensure-page.ts` | **新增**，~50 行，包含 `ensurePage`、`EnsurePageConfig`、`EnsurePageResult` |
| `src/sites/twitter/workflows.ts` | 重写三个 ensure 函数，`WaitRecord` 迁移到 `ensure-page.ts` 并 re-export，净减 ~70 行 |

不改动：`data-collector.ts`、`ensure-state.ts`、`extractors.ts`、三个 `get*` 工作流函数、存储层、测试 fixture。

### 测试策略

1. **新增 `src/sites/twitter/__tests__/ensure-page.test.ts`**：用 mock primitives + mock collector 测试 `ensurePage` 骨架。最小 case 集：
   - 正常路径：navigate → afterNavigate → 数据到了 → 返回 `reloaded: false`
   - reload 路径：数据没到 → reload → 数据到了 → 返回 `reloaded: true`
   - reload 后仍无数据：返回 `reloaded: true`，waits 两条记录均 `satisfied: false`
   - afterNavigate 抛异常：直接冒泡，不进 waitForData
   - afterReload 未提供：reload 后只 navigate 不做额外操作
   - waits timing：startedAt/resolvedAt 相对于 t0 的值正确
2. **现有 `workflows.test.ts`**：不改。它已有 `ensureTimeline`（5 case）和 `ensureTweetDetail`（3 case）的直接测试，重构后这些天然变成 `ensurePage` 的集成测试，覆盖端到端路径。新增的 `ensure-page.test.ts` 聚焦边界行为（钩子缺失、异常冒泡、timing），与已有测试分工互补、不重复。

### 风险

| 风险 | 缓解 |
|------|------|
| ensureTimeline 的 tab 切换涉及 collector 数据清理，钩子化后调用时序是否不变？ | `afterNavigate` 在 navigate 返回后同步调用，时序与当前 Step 2 完全一致。写测试验证。 |
| 三个 ensure 函数的返回类型略有不同（Timeline 多了 `navAction`/`tabAction`） | `ensurePage` 只返回 `{ reloaded, waits }`，Timeline 在外层补充额外字段。类型兼容。 |
| 现有测试是否会 break | 公开函数签名不变，只是内部实现委托给 `ensurePage`。workflows.test.ts 应绿灯。 |

---

## 代码量对比

| | 当前 | 提取后 |
|---|---|---|
| `ensurePage`（新） | — | ~50 行 |
| `ensureTimeline` | 70 行 | ~30 行 |
| `ensureTweetDetail` | 52 行 | ~10 行 |
| `ensureSearch` | 57 行 | ~14 行 |
| `checkLoginRedirect`（新） | — | ~10 行 |
| **合计** | **179 行** | **~110 行** |

净减 ~70 行，消除 3 份 `timedWait` 拷贝。更重要的是：新站点实现 ensure 逻辑只需填一个 `EnsurePageConfig`，不需要理解 reload 兜底和 timedWait 的实现细节。

---

## 设计边界：为什么只提取 ensure，不提取整条流水线

### 更大的重复

`ensurePage` 只消除了三个 `get*` 函数中**一个步骤**的重复。实际上三个顶层工作流（`getFeed`、`getTweetDetail`、`getSearch`）的整条骨架都高度相似：

```
get* 函数的共同骨架：
──────────────────────
1. createDataCollector()
2. interceptRequest(PATTERN, response => {
     dumpRaw?  →  写文件
     parse(response.body)  →  collector.push(...)
     graphqlCount++
   })
3. ensure*(primitives, collector, ...)     ← 本次提取的范围
4. collectData(scroll + wait)
5. collector.items.map(parseTweet).filter(!ad).slice(count)
6. buildFeedMeta + tweetToFeedItem
7. cleanup()
```

步骤 1、2、4、5、6、7 在三个函数里也是高度相似的。理想情况下，整条流水线可以声明为一个配置：

```typescript
// 理想形态：声明式 GraphQL 工作流
const twitterTimeline = defineGraphQLWorkflow({
  name: 'getFeed',
  intercept: {
    pattern: GRAPHQL_TIMELINE_PATTERN,
    parse: parseGraphQLTimeline,
  },
  ensurePage: {
    navigate: (p, opts) => navigateToTimeline(p, opts.tab),
    afterNavigate: (p, opts) => switchTab(p, opts.tab),
    afterReload: (p, opts) => switchTab(p, opts.tab),
  },
  transform: (raw) => raw.map(parseTweet).filter(t => !t.isAd),
  toFeedItem: tweetToFeedItem,
});
```

引擎负责 collector 创建、interceptor 装卸、dumpRaw、scroll 收集、tracing、cleanup——站点完全不碰这些。

### 为什么现在不做

**数据不够，强行泛化会做出只适合 Twitter 的假抽象。**

`getTweetDetail` 的 intercept handler 有 `anchor`/`hasCursor` 的额外语义（[workflows.ts:543-549](../../../src/sites/twitter/workflows.ts#L543-L549)），不能简单地用 `parse: fn` 一行覆盖。当前只见过 Twitter 一个站点的三个 endpoint，不清楚 XHS 或 Reddit 的 API 响应模式是否也遵循「GraphQL → entries → items」的结构。在单一数据点上设计声明式引擎，大概率会在第二个站点上被推翻。

设计文档（[site-use-design.md](../../site-use-design.md)）自身也写道：

> 做完 2-3 个站点后再提炼声明式引擎

### 分阶段演进路径

| 阶段 | 做什么 | 触发时机 | 信号 |
|------|--------|----------|------|
| **Phase 1**（本次） | 提取 `ensurePage` | 现在 | 3 个 ensure 函数已暴露清晰模式 |
| **Phase 2** | 观察第二个站点的 get* 骨架是否吻合 | 实现第二个站点时 | 两个数据点可做初步验证 |
| **Phase 3** | 提炼 `defineWorkflow` 声明式引擎 | 第三个站点上线前 | 三个数据点足以做可靠泛化 |

**Phase 1 的价值在于它是确定的。** 三个 ensure 函数的重复是事实，不是推测；提取后的接口是从代码中直接读出的，不需要猜测未来站点的需求。而 Phase 3 的声明式引擎需要跨站点验证才能确认接口形状，现在做是在赌。

**Phase 1 也为 Phase 3 铺路。** `ensurePage` 把 ensure 步骤变成了可插拔配置，未来 `defineWorkflow` 只需在外面再包一层流水线编排，不需要重新拆 ensure 逻辑。

### Phase 2 检查点

当第二个站点的 PR 进入 review 时，reviewer 必须对照本文档的「get* 共同骨架」，记录：

1. 新站点的 workflow 是否遵循 intercept → ensure → collect → transform 流水线？
2. `ensurePage` 是否被复用？如果复制了一份，记录偏差原因。
3. 新站点有哪些 get* 骨架之外的步骤？（如 getTweetDetail 的 anchor/hasCursor）

这些记录作为 Phase 3 `defineWorkflow` 设计的输入。如果第二个站点完全吻合，Phase 3 可以启动；如果偏差大，说明声明式引擎的假设有误，需要重新评估。
