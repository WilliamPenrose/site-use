# Feed 采集事件驱动重构设计

> 状态：设计中
> 日期：2026-03-28
> 关联：`docs/milestones/m2/twitter-timeline.md`（现有功能手册）

## 问题

当前 `getFeed` 的采集流程依赖硬编码的 `wait()` 延迟来等待 GraphQL 响应到达，导致两类问题：

### 1. 延迟浪费

典型一次 `twitter_feed` 调用耗时 ~8.4 秒（debug 实测），即使已经在正确页面上。分布：

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 初始盲等 `wait(2000)` | 2000ms | 等 GraphQL 响应，不管数据是否已到 |
| 滚动循环 x3 轮 | ~5100ms | 每轮 scroll ~200ms + `wait(1500)` |
| Tab 切换 + 状态检查 | ~1000ms | 正常开销 |
| 数据解析 | ~200ms | 正常开销 |

实测中，首次 GraphQL 响应返回了 129 条原始推文，远超 count=20 的需求，但 `collectTweetsFromTimeline` 仍要走完滚动循环才能退出。**大量等待时间是无效的。**

### 2. 重复 reload

`getFeed` 内部的导航、Tab 切换、数据采集三个阶段各自独立判断"有没有数据"，互不知情，导致以下最坏路径：

```
ensureState({ url }) -> already_there -> navigate(reload #1)
ensureState({ tab }) -> transitioned -> waitForData 超时 -> navigate(reload #2)
```

即使刚 reload 完，Tab 切换阶段仍可能触发第二次 reload，因为它不知道上游已经 reload 过。

根本原因：**导航和 Tab 选择是耦合的**——reload 后 Twitter 加载默认 Tab（For You），如果目标是 Following，reload 拿到的数据是错误 Tab 的。所以将它们拆成独立阶段并通过 flag 协调，解决不了问题。

## 历史背景

这些硬编码等待是逐步积累的防御性措施，解决过以下真实问题：

1. **拦截器晚于导航**（已修复）— 早期先导航再设拦截，首次 GraphQL 漏掉
2. **Tab 切换 Twitter 用缓存** — 切 Tab 后不发新 GraphQL 请求，拦截器收不到数据
3. **Stale detection 误判** — 没有等待时，scroll 后 GraphQL 还没回来，stale 计数瞬间满 3 轮就退出
4. **页面缓存失效** — 用户关了浏览器 Tab，Puppeteer 缓存的 page 对象变 stale

当前 `interceptRequest` 已经是事件驱动的（`page.on('response')`），但下游消费端没有用事件通知，而是用 polling + sleep 检查数组长度。

## 设计目标

- 将采集等待从"盲等固定时间"改为"等事件到达 + 超时兜底"
- 消除不必要的重复 reload
- 不修改 primitives 层
- 通用的等待协调工具，其他 site 插件可复用

## 不做

- 不改变 `interceptRequest` 的 API（primitives 层不动）
- 不改变 GraphQL 解析逻辑（`parseGraphQLTimeline` 不变）
- 不改变 feed 的输出格式（`FeedResult` 不变）
- 不做 scroll 的反检测优化（`humanScroll` 不变）

---

## 一、DataCollector — 异步数据收集工具

**位置**：`src/ops/data-collector.ts`

**职责**：封装异步到达的数据的收集、清空和条件等待。将 `interceptRequest` 的 callback 信号与数据存储绑定，消除 push/notify 分离的隐性契约。

### 设计动机

如果 push 和 notify 是两个独立操作（如独立的 awaiter 方案），callback 里必须同时调用两者。随着代码演化，有人加了 push 忘了 notify，系统静默失灵。DataCollector 把两者合一：`push()` 内部自动 notify，不可能遗漏。

### API

```typescript
interface DataCollector<T> {
  /** 添加数据并自动通知所有等待者重新评估 predicate。 */
  push(...items: T[]): void;

  /** 清空数据。不触发 notify（清空后等待者应等新数据到达）。 */
  clear(): void;

  /**
   * 等待直到 predicate 返回 true，或超时。
   * - 进入时立即检查 predicate（避免信号丢失的竞态）
   * - 每次 push() 时重新评估 predicate
   * - 返回 true = 条件满足，false = 超时
   */
  waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean>;

  /** 当前数据（只读视图）。 */
  readonly items: readonly T[];

  /** 当前数据量。 */
  readonly length: number;
}

function createDataCollector<T>(): DataCollector<T>;
```

### 为什么只有 `waitUntil`，没有 `waitForNext`

`waitForNext("等下一个信号")` 存在信号丢失的竞态：

```
navigate() 开始 -> 页面加载 -> GraphQL 响应到达 -> push() 触发
                                                 -> navigate() 返回
                                                 -> waitForNext() 开始等待  <- 信号已丢失
```

`waitUntil(predicate)` 天然免疫此问题——进入时先检查 predicate，如果条件已满足则立即返回 true。不依赖信号的时序。

### 超时设计

超时返回 `false`（而非抛异常），让调用方自行决定 fallback 策略。这是刻意的：超时不是异常状态，而是正常的"Twitter 可能用了缓存，需要 reload"的信号。

### 实现要点

- `push()` 添加数据后，遍历所有等待中的 listeners 让它们重新评估 predicate
- `clear()` 清空内部数组，不触发 listeners
- `waitUntil` 进入时先检查 predicate（同步），已满足则不进入异步等待
- 内部用一个简单的 listeners 列表，`push()` 遍历调用，`waitUntil` 注册/注销

---

## 二、两阶段管道

将当前 `getFeed` 内部的线性逻辑拆为两个阶段函数，`getFeed` 变成编排层。

### 阶段 1：ensureTimeline

**职责**：确保浏览器在 Twitter 首页的目标 Tab 上，且拦截器已捕获到该 Tab 的 GraphQL 数据。

```typescript
interface EnsureTimelineResult {
  navAction: 'already_there' | 'transitioned';
  tabAction: 'already_there' | 'transitioned';
  reloaded: boolean;
  waits: Array<{
    purpose: string;        // 如 'initial_data', 'after_tab_switch', 'after_reload'
    startedAt: number;      // 相对于 getFeed 开始的 ms
    resolvedAt: number;
    satisfied: boolean;     // true=predicate 满足, false=超时
    dataCount: number;      // 结束时 collector.length
  }>;
}

async function ensureTimeline(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { tab: TimelineFeed; t0: number },
): Promise<EnsureTimelineResult>
```

**流程**：

```
ensureState({ url: TWITTER_HOME })
  +-- transitioned -> 刚导航过去
  +-- already_there -> navigate 刷新（拦截器需要 GraphQL 响应）
         |
ensureState({ role: 'tab', name: tabName, selected: true })
  +-- already_there -> Tab 已对
  +-- transitioned -> 切了 Tab -> collector.clear()
         |
collector.waitUntil(() => collector.length > 0, 3000)
  +-- true -> 数据到了，继续
  +-- false -> 超时，触发 reload fallback（如果本次尚未 reload）
                +-- navigate(TWITTER_HOME)
                +-- ensureState({ tab })
                +-- collector.waitUntil(..., 3000)  <- 再等一次
                +-- 无论结果如何，进入 collectData
```

**关键设计决策**：

1. **导航和 Tab 选择在同一个函数内**——因为它们是耦合的。reload 后 Twitter 加载默认 Tab，必须立刻切到目标 Tab 才能拿到正确数据。

2. **`reloaded` 是内部状态**——只在 ensureTimeline 内部追踪，用于防止二次 reload。通过返回值暴露给 debug，但 collectData 不依赖它。

3. **Tab 切换时 `collector.clear()`**——切 Tab 后旧数据无效（来自错误 Tab），必须等新 Tab 的 GraphQL 响应。

4. **超时后最多 reload 一次**——如果 reload + 重新切 Tab 后仍无数据，不再重试，带着当前状态进入 collectData。滚动可能触发新的 GraphQL 请求。

5. **返回 result 对象**——包含 debug 所需的决策路径和 timing 信息。总是计算（`Date.now()` 开销可忽略），由 getFeed 决定是否输出。

### 阶段 2：collectData

**职责**：在初始数据基础上滚动补充，直到数据量达到 count 或确认没有更多。

```typescript
interface CollectDataResult {
  scrollRounds: number;
  waits: Array<{
    round: number;
    startedAt: number;
    resolvedAt: number;
    satisfied: boolean;
    dataCount: number;
  }>;
}

async function collectData(
  primitives: Primitives,
  collector: DataCollector<RawTweetData>,
  opts: { count: number; t0: number },
): Promise<CollectDataResult>
```

**流程**：

```
collector.length >= count ?
  +-- yes -> 直接返回（零延迟）
  +-- no -> 进入滚动循环
              |
         scroll down
              |
         prevTotal = collector.length
         collector.waitUntil(() => collector.length > prevTotal, 2000)
           +-- true -> 有新数据，staleRounds = 0
           +-- false -> 超时无新数据，staleRounds++
              |
         staleRounds >= MAX_STALE_ROUNDS(3) ?
           +-- yes -> 退出循环
           +-- no -> 继续滚动
```

**关键改进**：

1. **数据已够时零延迟返回**——当前实现即使首次 GraphQL 返回了 129 条（远超 count=20），仍要走完 `wait(2000)` + 3 轮滚动。改后立即返回。

2. **事件驱动的滚动等待**——从固定 `wait(1500)` 变为 `waitUntil(有新数据, 2000)`。数据快则快返回，2 秒超时兜底（略长于原 1500ms，给网络多一点余量）。

3. **stale detection 不再误判**——原来 `wait(1500)` 不够时会误判为 stale。现在用 `waitUntil` 等真实信号，超时才算一轮 stale，判断更准确。

### getFeed 编排层

```typescript
async function getFeed(primitives, opts): Promise<FeedResult> {
  const collector = createDataCollector<RawTweetData>();
  const t0 = Date.now();
  let graphqlResponseCount = 0;
  let graphqlParseFailures = 0;
  const notifyTimestamps: number[] = [];

  const cleanup = await primitives.interceptRequest(
    GRAPHQL_TIMELINE_PATTERN,
    (response) => {
      try {
        const parsed = parseGraphQLTimeline(response.body);
        collector.push(...parsed);        // push 内部自动 notify
        graphqlResponseCount++;
        notifyTimestamps.push(Date.now() - t0);
      } catch {
        graphqlParseFailures++;
      }
    },
  );

  try {
    const timelineResult = await ensureTimeline(primitives, collector, { tab, t0 });
    const collectResult = await collectData(primitives, collector, { count, t0 });

    // parse, filter, return (unchanged)
    const tweets = collector.items
      .map(parseTweet)
      .filter((t) => !t.isAd)
      .slice(0, count);

    // ... build FeedResult with debug info from timelineResult + collectResult
  } finally {
    cleanup();
  }
}
```

---

## 三、Debug 信息设计

`debug` 字段从扁平结构改为阶段化结构，便于分析每个阶段的延迟和决策路径。

```typescript
interface FeedDebug {
  tabRequested: string;
  graphqlResponseCount: number;
  graphqlParseFailures: number;       // GraphQL 响应解析失败次数
  notifyTimestamps: number[];         // 每次 push 的相对时间（ms）
  rawBeforeFilter: number;
  elapsedMs: number;

  ensureTimeline: {
    navAction: 'already_there' | 'transitioned';
    tabAction: 'already_there' | 'transitioned';
    reloaded: boolean;
    waits: Array<{
      purpose: string;
      startedAt: number;
      resolvedAt: number;
      satisfied: boolean;
      dataCount: number;
    }>;
  };

  collectData: {
    scrollRounds: number;
    waits: Array<{
      round: number;
      startedAt: number;
      resolvedAt: number;
      satisfied: boolean;
      dataCount: number;
    }>;
  };
}
```

### 排查场景与所需字段

| 问题 | 看什么 |
|------|--------|
| "feed 返回空数据" | `graphqlResponseCount` + `graphqlParseFailures` + `notifyTimestamps` 判断 GraphQL 是否到达并成功解析 |
| "feed 很慢" | `ensureTimeline.waits` + `collectData.waits` 的 timing 定位哪个阶段慢 |
| "不必要的 reload" | `ensureTimeline.reloaded` + `waits[].purpose` 看 reload 是否被触发以及原因 |
| "数据够了还在滚动" | `collectData.scrollRounds` 应为 0；非 0 说明 bug |
| "GraphQL 来了但没通知" | `notifyTimestamps` 和 `waits[].startedAt` 对比时序 |

---

## 四、历史 Edge Case 覆盖验证

| Edge Case | 原方案如何处理 | 新方案如何覆盖 |
|-----------|--------------|--------------|
| 拦截器晚于导航 | 先设拦截再导航 | 不变，设置顺序保持一致 |
| Tab 切换 Twitter 用缓存 | `waitForData` 3s 超时 -> reload | `waitUntil` 超时 -> reload fallback（ensureTimeline 内部） |
| Stale detection 误判 | `wait(1500)` 给 GraphQL 时间 | `waitUntil(有新数据, 2000)` — 等真实信号而非固定时间 |
| 页面缓存失效 | puppeteer-backend 层检测 | 不变，不在本次范围内 |
| 首次 GraphQL 数据已够 count | 仍走完 wait(2000) + 滚动循环 | `collectData` 开头直接检查，够了立即返回 |
| 重复 reload | 各阶段独立判断 | `reloaded` 标记在 ensureTimeline 内部，最多 reload 一次 |

---

## 五、预期延迟改善

### 场景 A：已在正确 Tab，首次 GraphQL 数据 >= count

| | 原方案 | 新方案 |
|--|--------|--------|
| ensureTimeline | navigate + wait(2000) = ~3s | navigate + waitUntil(有数据) = ~1s |
| collectData | wait(2000) + 3 轮滚动 = ~6.5s | 数据已够，直接返回 = ~0s |
| **总计** | **~8.5s** | **~1s** |

### 场景 B：需要切 Tab，首次数据不够需要滚动

| | 原方案 | 新方案 |
|--|--------|--------|
| ensureTimeline | navigate + tab + waitForData(3s) = ~4s | navigate + tab + waitUntil = ~1.5s |
| collectData | wait(2000) + N 轮滚动 x 1.7s | N 轮滚动 x (scroll + waitUntil) |
| **每轮滚动** | ~1.7s（固定） | ~0.5-2s（数据快则快） |

### 场景 C：Tab 切换 Twitter 缓存，需要 reload

| | 原方案 | 新方案 |
|--|--------|--------|
| | navigate + tab + 3s 超时 + reload + tab = ~7s | navigate + tab + 3s 超时 + reload + tab + waitUntil = ~5s |
| | 可能再触发一次 reload | 最多一次 reload |

---

## 六、测试策略

### DataCollector 单元测试

纯逻辑，不依赖浏览器，可以全面覆盖：

- `waitUntil` predicate 进入时已满足 -> 同步返回 true
- `waitUntil` 超时 -> 返回 false
- `push()` 唤醒等待中的 `waitUntil` -> 重新评估 predicate
- 多个并发 `waitUntil` 被同一个 `push()` 唤醒
- `push()` 在 `waitUntil` 之前调用 -> predicate 进入时已满足，不阻塞
- `clear()` 不触发等待者

### ensureTimeline 单元测试

Mock primitives（同现有 `workflows.test.ts` 的模式）：

- 已在正确 Tab -> 不切 Tab，只等数据
- 需要切 Tab -> 切 Tab 后等数据
- Tab 切换后超时 -> 触发 reload fallback
- Reload 后仍无数据 -> 不再重复 reload，进入 collectData
- 已在首页 vs 不在首页 -> navigate 行为差异
- 返回值包含正确的 navAction、tabAction、reloaded、waits

### collectData 单元测试

- `collector.length >= count` -> 直接返回，不滚动
- 滚动后新数据到达 -> staleRounds 重置
- 连续 3 轮无新数据 -> 退出
- 数据在滚动过程中逐步达到 count -> 提前退出
- 返回值包含正确的 scrollRounds 和 waits

### 合同测试（现有 workflows.test.ts 扩展）

验证 `getFeed` 的整体行为不变：
- 相同输入 -> 相同输出格式
- debug 字段正确反映阶段化的 timing 信息

---

## 七、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/ops/data-collector.ts` | 新增 | DataCollector 工具 |
| `tests/unit/data-collector.test.ts` | 新增 | 单元测试 |
| `src/sites/twitter/workflows.ts` | 重构 | getFeed 拆分为 ensureTimeline + collectData |
| `src/sites/twitter/__tests__/workflows.test.ts` | 更新 | 适配新结构，增加 edge case 覆盖 |
