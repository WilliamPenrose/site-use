# ensureState — 页面状态导航原语

> 状态：设计文档
> 所属层：`ops/`（站点无关的组合操作）
> 引入时机：M2（手写 workflow 使用） → M5（探索原语之一）

## 问题来源

实现 Twitter `getTimeline` 时发现：导航到 `x.com/home` 后默认显示 "For you" tab，而用户想看 "Following"。

直觉做法是"导航后点击 Following tab"——但需要处理：如果已经在 Following 上呢？点了会不会触发不必要的刷新？

进一步发现这是**所有站点都会面对的通用问题**：

- **URL 型**：导航后检查 URL 即可判断（如 `/home/following`）
- **SPA 型**：URL 不变，需要通过页面状态判断（如 Twitter 的 For You / Following tab，`aria-selected` 属性）
- **组合型**：先到正确 URL，再确保正确的 tab/筛选状态

需要一个**幂等**的状态导航原语——不管当前在哪，调用后收敛到目标状态。

## 设计

### 核心机制：check-then-load

借鉴 [Selenium LoadableComponent](https://github.com/SeleniumHQ/selenium/wiki/LoadableComponent) 的模式：

```java
// Selenium 原始实现
public T get() {
    try {
        isLoaded();       // 1. 已在目标状态？
        return (T) this;  //    是 → 直接返回（幂等）
    } catch (Error e) {
        load();           // 2. 不在 → 执行转换
    }
    isLoaded();           // 3. 再次验证
    return (T) this;
}
```

site-use 的 `ensureState` 将其适配为函数式 + 异步 + accessibility tree 驱动：

```
1. 检查 URL → 不匹配 → navigate()
2. takeSnapshot → 检查页面状态 → 不匹配 → click() 切换
3. 等待 settled（网络请求完成、DOM 稳定）
4. 再次 takeSnapshot → 验证最终状态
```

Selenium 的 `SlowLoadableComponent` 变体（`load()` 后在 timeout 内轮询 `isLoaded()`）同样适用——SPA 的 tab 切换后内容刷新是异步的。

### StateDescriptor

目标状态用结构化描述符表达，**不用自然语言**（不需要 LLM 参与，纯确定性）。

```typescript
interface StateDescriptor {
  // 页面级
  url?: string | RegExp;       // URL 条件

  // 元素级（可选，URL 到了之后再检查）
  role?: string;               // 控件类型（tab, combobox, checkbox...）
  name?: string | RegExp;      // 控件名称（accessible name）
  selected?: boolean;          // tab 是否选中
  expanded?: boolean;          // 面板是否展开
  checked?: boolean;           // 复选框/开关是否勾选
  value?: string;              // 下拉框/输入框的值
}
```

为什么是结构化描述符而不是自然语言？

1. **确定性**——不需要 LLM 参与，纯代码执行路径
2. **已有基础**——`SnapshotNode`（[types.ts](../../src/primitives/types.ts#L7-L18)）本身就是结构化的（role, name, selected, expanded），描述符直接对齐 snapshot 的数据结构
3. **MatcherRule 的自然延伸**——现有代码已经在用 `{ role, name }` 匹配元素，加几个状态字段即可

```typescript
await ensureState(primitives, { role: 'tab', name: 'Following', selected: true }, site);
```

### 与 MatcherRule 的关系

`StateDescriptor` 是现有 `MatcherRule`（[matchers.ts](../../src/sites/twitter/matchers.ts)）的自然演进：

```typescript
// M1 MatcherRule — 只匹配存在性
{ role: 'link', name: /^Home$/i }

// M5 StateDescriptor — 匹配存在性 + 状态
{ role: 'tab', name: 'Following', selected: true }
```

`MatcherRule` 回答"这个元素在不在"，`StateDescriptor` 回答"这个元素在不在，且状态对不对"。

实现时 `matchByRule()` 应从 `sites/twitter/matchers.ts` **提升**到 `ops/` 层，成为 `ensureState` 的内部组件。Twitter 的 `rules` 对象（homeNavLink、tweetComposeButton 等站点特定规则）留在 `sites/twitter/`。

### 支持的控件类型

不同控件的交互方式在 `ensureState` 内部处理，调用方不感知：

| 控件 | role | 状态字段 | 内部交互方式 |
|------|------|---------|-------------|
| Tab | tab | `selected` | click |
| 下拉框 | combobox / listbox | `value` | click → 找选项 → click |
| 复选框 | checkbox | `checked` | click |
| 折叠面板 | button / region | `expanded` | click |
| 单选按钮 | radio | `checked` | click |
| 开关 | switch | `checked` | click |

### 支持组合条件

URL 导航 + SPA 状态可以在一次调用中组合：

```typescript
const ensure = makeEnsureState(primitives, site);

// 纯 URL 导航
await ensure({ url: 'x.com/home' })

// 纯 SPA 状态
await ensure({ role: 'tab', name: 'Following', selected: true })

// 组合：先到 URL，再确保 tab 状态
await ensure({
  url: 'x.com/home',
  role: 'tab',
  name: 'Following',
  selected: true,
})

// 多条件（如 SaaS 筛选面板）
await ensure([
  { role: 'combobox', name: 'Region', value: 'Asia Pacific' },
  { role: 'combobox', name: 'Date Range', value: 'Last 7 days' },
])
```

多条件时逐个处理，每个条件之后等 settled——因为字段之间可能有依赖关系（如 Country 选择影响 City 选项）。

### ref 不能用于 ensureState

ref（= snapshot uid）的生命周期只在单次 snapshot 内有效（见 [overview.md — uid 生命周期规则](../overview.md)）。`ensureState` 内部会多次 `takeSnapshot()` 来验证状态，之前的 ref 会失效。必须用语义描述符（role + name）来定位元素。

### 返回值：带出内部已有的 snapshot

`ensureState` 内部为了验证状态转换是否成功，已经做了 `takeSnapshot()`。这个 snapshot 数据已经有了，带出来让后续操作直接使用，避免重复 snapshot：

```typescript
interface EnsureStateResult {
  reached: boolean;          // 是否成功到达目标状态
  action: 'already_there' | 'transitioned';  // 是否执行了转换
  snapshot: Snapshot;        // 验证时的 snapshot，调用方可直接使用
}
```

`snapshot` 不是额外计算的——它来自 ensureState 内部验证步骤的副产品。不带出来反而浪费。

**M2 中的价值**：workflow 代码在 ensureState 之后通常需要操作页面元素（如 matchByRule 找按钮再 click），直接用返回的 snapshot 即可，不用再调 `takeSnapshot()`。

```typescript
const ensure = makeEnsureState(primitives, TWITTER_SITE);
const { snapshot } = await ensure({ url: `https://x.com/${handle}` });

// 直接用 snapshot，不用再 takeSnapshot
const followUid = matchByRule(snapshot, rules.followButton);
await primitives.click(followUid, TWITTER_SITE);
```

**M5 中的价值**：每个原语都返回最新状态，agent 的决策循环不需要额外的 observe 调用——操作之间自然粘合。

```
ensure → 拿到 snapshot → 基于 snapshot 决定下一步 → ensure → 拿到新 snapshot → ...
```

M5 时可进一步将 `snapshot` 包装为更高级的 `PageState`（语义分组、精简后的结构，见 [00-thinking.md — 统一返回值](00-thinking.md#统一返回值)），但底层数据来源不变。

## API 设计

### 工厂模式

`ensureState` 采用工厂模式——先绑定上下文（primitives + site），再按需调用只传意图：

```typescript
// 绑定上下文
const ensure = makeEnsureState(primitives, TWITTER_SITE);

// 调用时只传意图——语义清晰，不重复传上下文
await ensure({ url: TWITTER_HOME });
await ensure({ role: 'tab', name: 'Following', selected: true });
```

为什么用工厂而不是直传三参数？

1. **调用方只关心"我要什么状态"**——primitives 和 site 是上下文噪音
2. **扩展性**——未来 ops 层的实现可能换底层（primitives 直连 → MCP 代理 → 其他），调用方的 `ensure()` 调用不变
3. **一个 workflow 内通常对同一个 site 操作多次**——绑定一次，多次使用

## 实现草案

```typescript
// ops/ensure-state.ts

import type { Primitives, Snapshot, SnapshotNode } from '../primitives/types.js';

interface StateDescriptor {
  url?: string | RegExp;
  role?: string;
  name?: string | RegExp;
  selected?: boolean;
  expanded?: boolean;
  checked?: boolean;
  value?: string;
}

interface EnsureStateResult {
  reached: boolean;
  action: 'already_there' | 'transitioned';
  snapshot: Snapshot;        // 验证时的 snapshot，调用方可直接使用
}

type EnsureStateFn = (
  target: StateDescriptor | StateDescriptor[],
) => Promise<EnsureStateResult>;

export function makeEnsureState(primitives: Primitives, site: string): EnsureStateFn {
  return async (target) => {
    const targets = Array.isArray(target) ? target : [target];
    let lastSnapshot: Snapshot | null = null;

    for (const t of targets) {
      // Step 1: URL check
      if (t.url) {
        const currentUrl = await primitives.evaluate<string>('window.location.href', site);
        const urlMatch = typeof t.url === 'string'
          ? currentUrl.includes(t.url)
          : t.url.test(currentUrl);

        if (!urlMatch) {
          const urlStr = typeof t.url === 'string' ? t.url : t.url.source;
          await primitives.navigate(urlStr, site);
        }
      }

      // Step 2: element state check (if element-level conditions exist)
      if (t.role) {
        const result = await ensureElementState(primitives, t, site);
        lastSnapshot = result.snapshot;
        if (!result.reached) return result;
      }
    }

    // If no element checks were done, take a snapshot for the caller
    if (!lastSnapshot) {
      lastSnapshot = await primitives.takeSnapshot(site);
    }

    return { reached: true, action: 'transitioned', snapshot: lastSnapshot };
  };
}

async function ensureElementState(
  primitives: Primitives,
  target: StateDescriptor,
  site: string,
): Promise<EnsureStateResult> {
  let snapshot = await primitives.takeSnapshot(site);
  const match = findByDescriptor(snapshot, target);

  if (!match) {
    throw new ElementNotFound(target);
  }

  if (meetsCondition(match, target)) {
    return { reached: true, action: 'already_there', snapshot };
  }

  // Execute transition
  await primitives.click(match.uid, site);

  // Poll until settled (SlowLoadableComponent pattern)
  let verified = false;
  snapshot = await pollUntilSettled(async () => {
    const snap = await primitives.takeSnapshot(site);
    const m = findByDescriptor(snap, target);
    if (m != null && meetsCondition(m, target)) {
      verified = true;
      return snap;
    }
    return null;
  });

  return { reached: verified, action: 'transitioned', snapshot };
}

function findByDescriptor(
  snapshot: Snapshot,
  target: StateDescriptor,
): SnapshotNode | null {
  for (const [uid, node] of snapshot.idToNode) {
    if (node.role !== target.role) continue;
    if (target.name) {
      const nameMatch = typeof target.name === 'string'
        ? node.name === target.name
        : target.name.test(node.name);
      if (!nameMatch) continue;
    }
    return { ...node, uid };
  }
  return null;
}

function meetsCondition(node: SnapshotNode, target: StateDescriptor): boolean {
  if (target.selected !== undefined && node.selected !== target.selected) return false;
  if (target.expanded !== undefined && node.expanded !== target.expanded) return false;
  // checked and value require SnapshotNode extensions — see open questions
  return true;
}
```

注意：这是实现草案，不是最终代码。`pollUntilSettled`、`ElementNotFound`、`checked`/`value` 的 snapshot 支持等细节待实现时确定。

## M2 使用场景

M2 新增的 4 个 workflow 中，ensureState 的适用性（详细分析见 [00-thinking.md](00-thinking.md#完整探索示例)）：

### getTimeline — URL + tab 切换

```typescript
// 当前代码
await primitives.navigate(TWITTER_HOME, TWITTER_SITE);

// 使用 ensureState
const ensure = makeEnsureState(primitives, TWITTER_SITE);
await ensure({ url: TWITTER_HOME });
await ensure({
  role: 'tab',
  name: feed === 'following' ? 'Following' : 'For you',
  selected: true,
});
```

解决了最初的 Following vs For You 问题——幂等，已在就跳过。

### searchUser — URL + People tab

```typescript
const ensure = makeEnsureState(primitives, TWITTER_SITE);
await ensure({ url: `https://x.com/search?q=${encodeURIComponent(query)}` });
await ensure({ role: 'tab', name: 'People', selected: true });
```

### getUserTweets — URL + Posts tab

```typescript
const ensure = makeEnsureState(primitives, TWITTER_SITE);
await ensure({ url: `https://x.com/${handle}` });
// Twitter profile 默认在 Posts tab，但显式确保更安全
await ensure({ role: 'tab', name: 'Posts', selected: true });
```

### getFollowingList — 纯 URL

```typescript
const ensure = makeEnsureState(primitives, TWITTER_SITE);
await ensure({ url: `https://x.com/${handle}/following` });
```

### followUser — 仅 URL 导航适用

```typescript
const ensure = makeEnsureState(primitives, TWITTER_SITE);
// ensureState 用于导航到 profile，返回的 snapshot 直接可用
const { snapshot } = await ensure({ url: `https://x.com/${handle}` });

// 点击 Follow 是动作，不是状态导航 — 直接用 primitives.click()
// 不用再 takeSnapshot，ensure 已经带出来了
const followUid = matchByRule(snapshot, rules.followButton);
await primitives.click(followUid, TWITTER_SITE);
```

Follow 是改变服务器状态的**动作**，不是页面状态导航。硬塞进 ensureState 语义不对。

### 适用性总结

| Workflow | ensureState 用途 | 价值 |
|----------|-----------------|------|
| `getTimeline` | URL + Following/ForYou tab | 解决最初的 tab 切换问题 |
| `searchUser` | URL + People tab | 两步状态导航 |
| `getUserTweets` | URL + Posts tab | 确保在正确 tab |
| `getFollowingList` | URL | 简单但统一 |
| `followUser` | 仅 URL 部分 | 核心动作不适用 |

**4/5 个 workflow 天然受益**，且导航逻辑统一为同一个模式。

## M5 中的角色

ensureState 是五个探索原语之一（见 [00-thinking.md — 三层架构](00-thinking.md#三层架构)），但它是**唯一在手写 workflow 中也有价值的原语**。

其他四个原语（observe, act, extract, fill）只在 M5 探索模式下有意义——M1-M4 的 workflow 一切已知，不需要侦察或试探。

这使 ensureState 成为 ops 层的**锚点**——它在 M2 就证明了 ops 层的存在价值，为 M5 的其他原语铺好了层级结构。

## 架构位置

```
src/
├── sites/twitter/
│   ├── rules.ts          # 站点特定的 ARIA 规则（homeNavLink, followButton...）
│   ├── extractors.ts
│   └── workflows.ts      # 调用 ensureState + primitives
├── ops/
│   ├── ensure-state.ts   # ensureState()（M2 引入）
│   └── matchers.ts       # matchByRule(), findByDescriptor()（从 twitter/ 提升）
├── primitives/
│   └── types.ts          # SnapshotNode 已有 selected, expanded 字段
└── browser/
```

依赖方向：`sites/twitter/workflows → ops/ensure-state → ops/matchers → primitives`

## 开放问题

- **SnapshotNode 的 checked/value 支持**：当前 `SnapshotNode` 有 `selected`、`expanded`，但没有 `checked`、`value`。下拉框和复选框的状态检测可能需要扩展 snapshot 或用 `evaluate()` 补充。
- **settled 检测策略**：click 后等多久才算页面稳定？固定 timeout？还是检测 network idle + DOM 变化停止？
- **下拉框的交互流程**：`ensureState({ value: 'X' })` 作用于 combobox 时，需要先 click 打开下拉列表，找到选项再 click——这比 tab 切换复杂，是否需要特殊处理？
- **错误语义**：元素找到但状态转换失败（如 click 后 tab 仍未切换）——应该抛什么错误？重试几次？

## 参考资料

| 来源 | 关键贡献 |
|------|---------|
| [Selenium LoadableComponent](https://github.com/SeleniumHQ/selenium/wiki/LoadableComponent) | check-then-load 幂等模式；链式依赖；SlowLoadableComponent 轮询变体 |
| [GOI: Declarative LLM-friendly Interfaces](https://arxiv.org/abs/2510.04607) | state declaration 原语；policy-mechanism 分离 |
| [Beyond Browsing: API-Based Web Agents](https://arxiv.org/abs/2410.16464) | 返回值自带状态 > 额外验证调用 |
| [State Objects (ACM Queue)](https://queue.acm.org/detail.cfm?id=2793039) | 同一 URL 多状态；状态转换类型化 |
| [M5 构思文档](00-thinking.md) | 探索原语设计；ops 层定义；M2 适用性分析 |
| [Milestones overview](../overview.md) | M2 workflow 列表；uid 生命周期规则；SnapshotNode 定义 |
| [Twitter matchers.ts](../../src/sites/twitter/matchers.ts) | 现有 MatcherRule 接口；matchByRule 实现 |
| [Primitives types.ts](../../src/primitives/types.ts) | SnapshotNode 已有 selected/expanded 字段（第 16-17 行） |
