# ADR: Locale-Agnostic Element Locators for Twitter

> Date: 2026-03-31
> Status: Accepted

## Context

site-use 当前通过 ARIA name（无障碍名称）匹配 Twitter UI 元素，这些 name 是用户可见的文案映射，会随界面语言变化。当用户的 Twitter 设为中文、韩语、日语等非英文语言时，所有依赖英文文案的匹配规则全部失效。

### 受影响的代码

| 位置 | 硬编码文案 | 用途 |
|------|-----------|------|
| `src/sites/twitter/site.ts:78` | `name: /^Home$/i` | 登录态检测：轮询 Home link 判断已登录 |
| `src/sites/twitter/workflows.ts:101` | `'Following'` / `'For you'` | Timeline tab 切换 |
| `src/sites/twitter/matchers.ts:13` | `name: /^Home$/i`, `name: /compose/i` | Matcher 规则定义 |

## Research

### 1. DOM 属性跨语言实测

在 site-use Chrome 实例中，将 Twitter 语言分别切换为英文、韩语、日语，对比关键元素属性：

| 元素 | 属性 | EN | KO | JA | 语言无关？ |
|------|------|-----|-----|-----|:---:|
| Home link | `data-testid` | `AppTabBar_Home_Link` | `AppTabBar_Home_Link` | `AppTabBar_Home_Link` | **Yes** |
| Home link | ARIA name | Home | 홈 | ホーム | No |
| Compose btn | `data-testid` | `SideNav_NewTweet_Button` | `SideNav_NewTweet_Button` | `SideNav_NewTweet_Button` | **Yes** |
| Compose btn | ARIA name | Post | 게시하기 | ポストする | No |
| For you tab | `textContent` | For you | 추천 | おすすめ | No |
| Following tab | `textContent` | Following | 팔로잉 | フォロー中 | No |
| Tabs | `data-testid` | null | null | null | N/A |
| Tabs | `aria-label` | null | null | null | N/A |
| Tabs | `aria-selected` | true/false | true/false | true/false | **Yes** |
| All nav links | `href` | 不变 | 不变 | 不变 | **Yes** |

**结论**: `data-testid` 和 `href` 跨语言稳定。Tabs 是唯一没有 `data-testid` 的关键元素——只有 `textContent`（随语言变）和 `aria-selected`（稳定）可用。

### 2. 业界方案调研

**Control Panel for Twitter** ([insin/control-panel-for-twitter](https://github.com/insin/control-panel-for-twitter)) — **2.5k stars, 215 releases, 活跃维护至 2026-02**

该项目是 Twitter 浏览器扩展领域最大的开源项目之一，它对 Timeline tabs 的定位方式是 **position-based（位置定位）**：

```js
// Following tab — nth-child(2)
$followingTabLink = $timelineTabs.querySelector(
  'div[role="tablist"] > div:nth-child(2) > [role="tab"]'
)

// For you tab — first-child
$forYouTabLink = $timelineTabs.querySelector(
  'div[role="tablist"] > div:first-child > [role="tab"]'
)

// 判断 For you 是否选中
isForYouTabSelected = Boolean($timelineTabs.querySelector(
  'div[role="tablist"] > div:first-child > [role="tab"][aria-selected="true"]'
))
```

完全没有使用文本匹配。依赖的是 `role="tablist"` 容器 + CSS 位置选择器 + `role="tab"` + `aria-selected` 状态。

**该项目维护了 4 年，跟踪了无数次 Twitter UI 改版，始终使用 `nth-child` 定位 tab，验证了 tab 位置的长期稳定性。**

其他项目的做法：
- **BeyondMachines/TwitterFollowingFixer**: 文本匹配 `tab.textContent.includes('Following')`，仅英文可用
- **Yoshiin gist**: 多语言文本列表 `['Following', 'Abonnements']`，需手动维护，无法覆盖所有语言

### 3. Playwright 官方态度

Playwright 文档对 `nth()` 的建议是 "use with caution"——因为通用页面的元素顺序可能变化。但 Twitter 的 For you / Following tab 是产品级固定结构（tab 0 = For you, tab 1 = Following），不属于"随机列表中第 N 项"的场景。Control Panel for Twitter 的 4 年实践验证了这一判断。

## Decision

### 第一层决策：定位策略选择

采用 `evaluate()` + CSS 选择器方案（纯 evaluate 方案），统一解决所有 i18n 定位问题。

#### 评估的三种实现方案

**方案 A：扩展 StateDescriptor 支持 scoped index**

在 snapshot 匹配体系内增加 `parent` 和 `index` 字段，支持"在某个父容器内按位置选择子元素"。登录检测用 `evaluate()` 查 `data-testid`。

```ts
ensure({
  parent: { role: 'tablist' },
  role: 'tab',
  index: 1,
  selected: true,
})
```

- 优点：Tab 交互保留 throttle 和人类模拟行为；在 snapshot 体系内，未来其他站点可复用
- 缺点：StateDescriptor 和 `findByDescriptor` 要加 parent scoping 逻辑，改动不小；当前 snapshot 是扁平 Map，从未使用过树结构遍历——这是第一次引入；登录检测用 evaluate + tab 用 snapshot = 两套机制（不一致）；当前只有 Twitter timeline 一个场景需要 scoped index，YAGNI 风险

**方案 B：纯 evaluate() 方案** ✅ 选定

所有 i18n 相关的元素定位统一通过 `evaluate()` + CSS 选择器完成。

```ts
// 登录检测
await primitives.evaluate<boolean>(
  `!!document.querySelector('[data-testid="AppTabBar_Home_Link"]')`
)

// Tab 切换
await primitives.evaluate(`
  document.querySelectorAll('[role="tablist"] [role="tab"]')[1]?.click()
`)
```

- 优点：改动最小最直接；CSS 选择器天然有作用域（不需要实现 parent scoping）；一套机制解决所有问题（一致性好）；与 Control Panel for Twitter（2.5k stars）的做法完全对齐
- 缺点：Tab 点击绕过 snapshot uid → click(uid) 体系；绕过 click 原语中的 throttle 延迟、坐标抖动、Bezier 鼠标轨迹

**方案 C：扩展 SnapshotNode 带出 DOM 属性**

让 `takeSnapshot()` 采集时额外读取 `data-testid` 等 DOM 属性。

- 优点：所有匹配都在 snapshot 体系内
- 缺点：破坏 Primitives 与 devtools-mcp 的对齐；`takeSnapshot()` 是最核心的技术点，改它影响面大；仍然不能解决 tab 问题（tab 没有 data-testid），还是要回到 index 方案

#### 对比矩阵

| | A: Scoped Index | B: Pure evaluate() | C: 扩展 SnapshotNode |
|---|:---:|:---:|:---:|
| 改动量 | 中 | **小** | 大 |
| 解决 tab 问题 | ✅ | ✅ | ❌ 仍需 index |
| 解决 login 问题 | ✅ (evaluate) | ✅ | ✅ |
| 保留 click 人类模拟 | ✅ | ❌ | ✅ |
| 作用域安全 | 需额外实现 | **CSS 天然支持** | 需额外实现 |
| 一致性 | 两套机制 | **一套机制** | 两套机制 |
| 对齐 devtools-mcp | ✅ | ✅ | ❌ |
| 反检测风险 | 无 | **极低** | 无 |

#### 选择理由

选择方案 B，核心判断：

1. Tab 切换是页内 UI 操作（非 follow/like 等社交行为），反检测风险极低，绕过人类模拟可以接受
2. CSS 选择器天然有作用域（`[role="tablist"] [role="tab"]`），不需要为 snapshot 实现 parent scoping
3. YAGNI——当前只有 Twitter timeline tab 一个场景需要 index 定位，不值得引入 scoped index 复杂度
4. 一套 evaluate() 机制统一解决所有 i18n 问题，比 A 方案的"两套机制"更一致

留一个口子：如果未来多个站点都需要 scoped index 定位，再考虑方案 A 作为通用能力引入 StateDescriptor。

### 第二层决策：定位方式选择

| 元素 | 定位策略 | 依据 |
|------|---------|------|
| Home link（登录态检测）| `data-testid="AppTabBar_Home_Link"` | 实测跨语言稳定 |
| Compose button | `data-testid="SideNav_NewTweet_Button"` | 实测跨语言稳定 |
| For you tab | `[role="tablist"] [role="tab"]:first-child` 或 index 0 | Control Panel for Twitter (2.5k stars) 验证 |
| Following tab | `[role="tablist"] [role="tab"]` index 1 | 同上 |
| Tab 选中状态 | `aria-selected` | 实测跨语言稳定 |

### 被否决的定位策略

1. **多语言映射表** (`/^(Home|首页|ホーム|홈)$/i`): 需维护 40+ 语言的翻译列表，Twitter 更新文案时需同步更新，维护成本过高
2. **运行时探测语言 + 翻译表**: 本质同上，只是查表时机不同
3. **仅文本匹配**: 仅英文可用，BeyondMachines/TwitterFollowingFixer 的反面教材

## Consequences

- 非英文用户的 workflow 不再失效
- 减少对 ARIA name 的依赖，降低 Twitter 文案更新带来的维护成本
- Tab 定位依赖固定位置，如果 Twitter 将来调整 tab 顺序（极低概率）需要更新
- Tab 点击使用 JS `.click()` 而非 CDP Input 域，不经过人类模拟层——这是有意的 trade-off，因为 tab 切换不是反检测敏感操作
- 如果未来多站点都需要 scoped index 定位，应回顾方案 A 将其作为通用能力引入
