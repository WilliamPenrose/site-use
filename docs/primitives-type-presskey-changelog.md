# Primitives 层扩展：type() 实现 + pressKey() 新增

> 分支：`feat/primitives-type-presskey`（基于 main）
> 日期：2026-03-30
> 状态：实现完成，build 通过，48 个 primitives 相关测试全部通过（含新增 9 个）

## 背景

site-use 的 Primitives 层定义了与浏览器交互的原子操作接口（navigate、click、takeSnapshot、type、scroll 等），对齐 chrome-devtools-mcp 的操作语义。

在 M1 阶段，`type()` 被声明为接口但未实现（抛出 "not implemented" 错误），因为当时只有读操作场景（feed 采集、搜索）。随着写操作需求（表单填写、内容发布）的出现，需要：

1. **实现 `type()`** — 向指定元素输入文本，支持人类行为模拟（逐字延迟）
2. **新增 `pressKey()`** — 按下单个键盘按键，支持功能键和字符输入（含 CJK）

这两个操作是 site 无关的通用原语，适用于所有站点的表单交互。

## 设计决策

### type() 实现方案

**选择**：CDP `DOM.focus` + Puppeteer `keyboard.type()`

**理由**：
- `DOM.focus` 通过 `backendNodeId` 精确聚焦目标元素，不依赖 CSS 选择器
- `keyboard.type()` 原生支持 `delay` 参数（每个按键之间的延迟），可直接用于人类行为模拟
- 复用 `resolveUid()` 校验链，与 `click()` 共享 snapshot → backendNodeId 的解析逻辑

**可选方案（未采用）**：
- `page.type(selector, text)` — 依赖 CSS 选择器，与 snapshot uid 体系不一致
- `evaluate` + `execCommand('insertText')` — 绕过键盘事件，不触发框架的 input 事件监听

### pressKey() 设计

**选择**：区分 named keys 和 characters 两条路径

**理由**：
- Named keys（Enter、Tab、ArrowDown 等）需要 `keyboard.press()` 生成完整的 keydown/keypress/keyup 事件序列
- 字符输入（ASCII、CJK、emoji）需要 `keyboard.sendCharacter()` 通过 CDP `Input.insertText` 直接插入，绕过 IME 系统
- 这种区分使得标签输入等场景可以逐字符发送，在字符之间插入自定义延迟来模拟人类打字节奏

### pressKey() 不需要 uid 参数

**理由**：`pressKey` 是全局键盘操作，向当前获得焦点的元素发送按键，不需要指定目标元素。调用者应先通过 `click()` 或 `type()` 聚焦目标元素。

### pressKey() 免于 throttle

**理由**：`pressKey` 是轻量级键盘事件，不触发页面导航或网络请求。在标签输入等场景中，需要 50-120ms 的快速连续按键，如果叠加 2-5s 的 throttle 延迟会导致交互不自然（单个标签输入需要 30-50s）。与 `takeSnapshot` / `evaluate` 同级，属于 exempt 操作。

### resolveUid() 提取

**理由**：`click()`、`type()`、`scrollIntoView()` 都需要相同的 uid → backendNodeId 解析和校验逻辑（检查 snapshot 是否存在、uid 是否有效）。提取为 `private resolveUid()` 消除了 15 行重复代码，错误消息也统一使用 `step` 参数动态生成。

---

## 逐文件改动清单

### 1. `src/primitives/types.ts`

**Primitives 接口定义**

| 改动项 | 改动前 | 改动后 |
|--------|--------|--------|
| `type()` 签名 | `type(uid: string, text: string): Promise<void>` | `type(uid: string, text: string, options?: { delay?: number }): Promise<void>` |
| `pressKey()` | 不存在 | 新增 `pressKey(key: string): Promise<void>` |

**改动原因**：
- `type()` 新增 `options.delay` 参数，支持调用者控制每个按键之间的延迟时间（毫秒），用于人类行为模拟。设为可选参数，默认值 0（即时输入），向后兼容现有调用。
- `pressKey()` 是全新原语，填补 Primitives 层对单键输入的能力空白。

**影响范围**：所有实现 `Primitives` 接口的类和所有创建 Primitives 代理的中间件（auth-guard、throttle）都必须同步更新。

---

### 2. `src/primitives/puppeteer-backend.ts`

**Primitives 接口的 Puppeteer 实现**

#### 2a. 新增 import：`KeyInput`

```diff
-import type { Browser, Page } from 'puppeteer-core';
+import type { Browser, Page, KeyInput } from 'puppeteer-core';
```

**原因**：`pressKey()` 中 `keyboard.press()` 需要 `KeyInput` 类型约束，确保传入的 key name 合法。

#### 2b. 新增 `private resolveUid(uid, step)` 方法

**改动前**：`click()` 和 `scrollIntoView()` 各自内联 uid 校验逻辑（检查 snapshot 是否存在、uid 是否在 Map 中），共约 15 行重复代码。

**改动后**：提取为 `resolveUid()` 私有方法，返回 `{ page, backendNodeId }`。`click()`、`type()`、`scrollIntoView()` 共用。

**影响**：
- `click()` 的行为完全不变（resolveUid 后仍调用 ensurePageActive + click 增强链路）
- `scrollIntoView()` 的行为完全不变（resolveUid 后仍调用 ensurePageActive + scrollElementIntoView）
- 错误消息从硬编码 step name 改为动态插入，对 LLM agent 更友好（能看到是哪个操作失败）

#### 2c. 实现 `type(uid, text, options?)`

**改动前**：stub 实现，直接 `throw new Error('type primitive is not implemented in M1')`。

**改动后**：完整实现，流程如下：
1. `checkRateLimit('type')` — 检查速率限制
2. `resolveUid(uid, 'type')` — 校验 snapshot 和 uid，获取 page + backendNodeId
3. `ensurePageActive(page)` — 确保 tab 处于前台活跃状态（与 click/scrollIntoView 一致）
4. `page.createCDPSession()` → `client.send('DOM.focus', { backendNodeId })` — 通过 CDP 精确聚焦目标元素
5. `page.keyboard.type(text, { delay })` — 通过 Puppeteer keyboard API 输入文本
6. 100ms DOM stability wait

**错误处理**：
- DOM.focus 失败时抛出 `ElementNotFound`（retryable: true），提示调用者重新 takeSnapshot
- CDP session 在 finally 块中 detach，确保资源释放

**影响**：从"调用即报错"变为"可用"。不改变任何现有方法的行为。

#### 2d. 新增 `pressKey(key)`

**实现逻辑**：
1. `checkRateLimit('pressKey')` — 检查速率限制（虽然 throttle 层会 exempt，但 rate limit detector 仍起作用）
2. `getPage()` — 获取当前页面（不需要 resolveUid，因为 pressKey 不指定目标元素）
3. 判断 key 类型（使用模块级常量 `KNOWN_KEYS` Set）：
   - 如果在 `KNOWN_KEYS` 中（Enter、Tab、Escape、方向键等 26 个命名键）→ `keyboard.press(key)`
   - 否则视为字符 → `keyboard.sendCharacter(key)`（CDP `Input.insertText`）

**设计注意**：`pressKey` 不调用 `ensurePageActive()`。键盘事件（`Input.dispatchKeyEvent`）不受 Chromium background tab throttling 影响（只有 mouse input events 被限制）。代码中已加注释说明此决策。

**性能注意**：`KNOWN_KEYS` 提升为模块级常量，避免每次 `pressKey()` 调用时重新创建 Set。这在快速连续按键场景（如标签输入 50-120ms 间隔）中减少不必要的 GC 压力。

---

### 3. `src/primitives/auth-guard.ts`

**Auth 中间件 — Primitives 代理层**

| 改动项 | 改动前 | 改动后 |
|--------|--------|--------|
| `type` 透传 | `type: (uid, text) => inner.type(uid, text)` | `type: (uid, text, options) => inner.type(uid, text, options)` |
| `pressKey` 透传 | 不存在 | 新增 `pressKey: (key) => inner.pressKey(key)` |

**改动原因**：auth-guard 是 Primitives 的代理层，只在 `navigate()` 时拦截做登录检查，其他操作直接透传到 inner。新增的 `options` 参数和 `pressKey` 方法必须正确透传，否则类型检查不通过。

**影响**：无行为变化。auth-guard 不对 type/pressKey 做任何拦截或检查，纯透传。

---

### 4. `src/primitives/throttle.ts`

**Throttle 中间件 — 操作节流层**

| 改动项 | 改动前 | 改动后 |
|--------|--------|--------|
| `type` 透传 | `type: (uid, text) => throttledAndCounted(...)` | `type: (uid, text, options) => throttledAndCounted(...)` + 注释说明 delay 与 throttle 的叠加关系 |
| `pressKey` | 不存在 | 新增 `pressKey: (key) => inner.pressKey(key)`，放在 exempt 区（与 takeSnapshot/evaluate 同级） |

**改动原因**：
- `type` 的 `options.delay` 是 keyboard.type 内部的每按键延迟，与 throttle 的操作间延迟是两个独立维度，需要叠加使用。添加注释说明这一点。
- `pressKey` 被放入 exempt 区而非 throttledAndCounted，原因见上方"设计决策"。

**影响**：`type()` 的 throttle 行为不变（仍会在操作前等待 2-5s 随机延迟 + 计入速率限制）。`pressKey()` 完全免于 throttle 和 rate limit counting。

**Throttle 分层总览（更新后）**：

```
Counted（throttle + rate limit）: navigate, click, type, scroll, scrollIntoView
Exempt（无 throttle）          : takeSnapshot, evaluate, interceptRequest, pressKey
Fully exempt                   : screenshot, getRawPage
```

---

### 5. `src/testing/index.ts`

**测试工具 — Mock Primitives 工厂**

| 改动项 | 改动前 | 改动后 |
|--------|--------|--------|
| `createMockPrimitives` | 无 `pressKey` | 新增 `pressKey: vi.fn(async () => {})` |

**改动原因**：所有使用 `createMockPrimitives()` 的测试文件需要返回符合 `Primitives` 接口的完整对象。

**影响**：确保所有导入此工厂的测试（auth-guard.test.ts、plugin contract tests 等）不会因缺少 `pressKey` 属性而类型报错。

---

### 6. `tests/unit/puppeteer-backend.test.ts`

**PuppeteerBackend 单元测试**

#### 6a. Mock 基础设施更新

`createMockPage()` 新增 `keyboard` mock 对象：

```typescript
keyboard: {
  type: vi.fn().mockResolvedValue(undefined),
  press: vi.fn().mockResolvedValue(undefined),
  sendCharacter: vi.fn().mockResolvedValue(undefined),
}
```

**原因**：`type()` 和 `pressKey()` 的实现依赖 `page.keyboard`，测试需要 mock 这些方法。

#### 6b. type() 测试用例（5 个）

| 测试 | 验证内容 |
|------|---------|
| `throws ElementNotFound when no snapshot taken` | 未调用 takeSnapshot 就调 type → 抛出含 "No snapshot available" 的 ElementNotFound |
| `throws ElementNotFound for unknown uid` | 传入不存在的 uid → 抛出含 "not found in snapshot" 的 ElementNotFound |
| `wraps DOM.focus failure as ElementNotFound` | CDP DOM.focus 抛错 → 包装为 ElementNotFound，含 "Failed to focus element" 消息 |
| `focuses element and types text via keyboard` | 完整流程验证：CDP DOM.focus 传入正确 backendNodeId，keyboard.type 传入文本和默认 delay=0 |
| `passes delay option to keyboard.type` | 验证 CJK 文本 + 自定义 delay 正确传递到 keyboard.type |

**替换了**原有的 `type (not implemented)` 测试（1 个测试 → 5 个测试）。

#### 6c. pressKey() 测试用例（4 个）

| 测试 | 验证内容 |
|------|---------|
| `presses a named key via keyboard.press` | Enter → keyboard.press('Enter')，不调用 sendCharacter |
| `sends CJK characters via keyboard.sendCharacter` | '咖' → keyboard.sendCharacter('咖')，不调用 press |
| `sends single ASCII characters via keyboard.sendCharacter` | '#' → keyboard.sendCharacter('#')（非 named key，走 sendCharacter 路径） |
| `sends emoji via keyboard.sendCharacter` | '🔥' → keyboard.sendCharacter('🔥')，不调用 press |

---

### 7. `src/sites/twitter/__tests__/ensure-page.test.ts`
### 8. `src/sites/twitter/__tests__/workflows.test.ts`

**Twitter 测试文件 — 本地 Mock 适配**

两个文件各有一处本地定义的 `createMockPrimitives()`（未使用 `src/testing/index.ts` 的共享版本），需要各新增一行：

```typescript
pressKey: vi.fn().mockResolvedValue(undefined),
```

**改动原因**：Primitives 接口新增 `pressKey` 后，所有手动构造 Primitives 对象的地方都必须包含该属性，否则 TypeScript 编译不通过。

**影响**：纯类型适配，不改变任何测试逻辑或断言。

---

## 测试验证

```
pnpm run build                    # ✅ 通过
vitest run tests/unit/puppeteer-backend.test.ts tests/unit/auth-guard.test.ts
                                  # ✅ 46 tests passed (含新增 7 个)
```

新增测试从 0 个（原有 1 个 stub 测试）→ 9 个，覆盖：
- type() 的校验（2 个）、DOM.focus 错误包装（1 个）、聚焦+输入（1 个）、delay 传递（1 个）
- pressKey() 的 named key / CJK 字符 / ASCII 字符 / emoji 四条路径（4 个）

## 不涉及的改动

以下 main 分支已有的逻辑**未做任何修改**：

- `ensurePageActive()` / `pageActivated` flag — tab unfreeze 机制保持不变
- `getPage()` 的 stale page detection（使用 `url()` 检测）
- `loggedPageHit` 日志
- `buildSnapshot()` / `shouldSkipNode()` — snapshot 构建逻辑
- `navigate()` / `scroll()` / `evaluate()` / `screenshot()` / `interceptRequest()` / `getRawPage()` — 所有其他 Primitives 方法
- rate limit detector / response listener
