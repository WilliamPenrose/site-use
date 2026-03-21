# ghost-cursor vs site-use 鼠标轨迹实现对比

> **版本**: 2026-03-21
> **对比对象**: ghost-cursor v1.3.0 vs site-use `generateBezierPath()` + `clickWithTrajectory()`
> **参考**: [ghost-cursor 源码](https://github.com/Xetera/ghost-cursor) | PRB 通过 `page.realClick()` 集成 ghost-cursor

---

## 背景

site-use 自研了贝塞尔曲线鼠标轨迹（不依赖 ghost-cursor），已实现弧线路径、easing 加减速、逐点微噪声。本文档对比 ghost-cursor 的实现细节，识别自研方案的差距并规划改进。

---

## 逐项对比

### 1. 曲线类型与控制点

| | site-use | ghost-cursor |
|---|---|---|
| 曲线阶数 | 三次贝塞尔（2 个控制点） | 三次贝塞尔（2 个控制点） |
| 控制点位置 | 固定在路径 25% 和 75% 处 + 随机偏移 | 路径上随机选点 + **垂直偏移** |
| 控制点方向 | 双侧随机（可能产生 S 形） | 避免对称 S 形，倾向单侧弯曲 |

**差距**：site-use 的控制点位置固定（0.25/0.75），每次曲线的"形状模式"相似。ghost-cursor 随机选取路径上的点再做垂直偏移，曲线形态更多样。

**建议**：⚡ 低优先级。当前方案已通过验证，形状多样性对检测的影响较小。

---

### 2. 偏移幅度（Spread）

| | site-use | ghost-cursor |
|---|---|---|
| 计算方式 | ~~`distance * 0.3`~~ → `clamp(distance * 0.3, 2, 200)` | `clamp(distance, 2, 200)` 固定像素范围 |
| 最小值 | 2px ✅ | 2px |
| 最大值 | 200px ✅ | 200px |

**~~差距~~** ✅ 已对齐：`Math.max(2, Math.min(200, distance * 0.3))`

---

### 3. 时间采样（Easing）

| | site-use | ghost-cursor |
|---|---|---|
| 方式 | `easeInOutCubic(t)` 应用于时间参数 | 纯贝塞尔插值（不修改 t） |
| 加减速来源 | 显式 easing 函数 | 隐式：控制点分布 + 速度导数计算 |
| 速度变化 | 均匀（弯曲处和直线处速度相同） | **弯曲处减速**（通过 `bezierCurveSpeed()` 导数） |

**差距**：site-use 的 easing 只影响"走到哪了"（位置），不影响"弯道减速"。ghost-cursor 通过贝塞尔速度导数计算每段的实际速度，弯曲处自然减速。

**建议**：⚡ 中优先级。当前 easing 已能模拟基本的加速/减速，弯道减速是更精细的优化。

---

### 4. 手部抖动（Noise）

| | site-use | ghost-cursor |
|---|---|---|
| 实现方式 | 显式 ±1px 逐点噪声 | 无显式噪声（隐含在控制点随机性中） |
| 最后一个点 | 无噪声（精确落点）✓ | 无噪声（精确落点）✓ |

**差距**：两种方案思路不同。site-use 的显式噪声更直接但也更规律（均匀分布），ghost-cursor 的"噪声"来自曲线本身的随机形状。

**建议**：— 无需改动。两种方案效果相当。

---

### 5. 步数计算

| | site-use | ghost-cursor |
|---|---|---|
| 公式 | ~~`max(10, distance / 15)`~~ → `max(25, ceil((log₂(d/10+1) + 2) * 3))` 对数 | `ceil((log₂(fitts(distance, width) + 1) + baseTime) * 3)` 对数 |
| 最小步数 | 25 ✅ | 25 (`MIN_STEPS`) |
| 理论基础 | **Fitts' Law** ✅ | **Fitts' Law**（人类运动控制理论） |
| 短距离(50px) | ~25 步 | ~25 步 |
| 中距离(500px) | ~25 步 | ~30 步 |
| 长距离(1500px) | ~27 步 | ~35 步 |

**~~差距~~** ✅ 已对齐：对数公式，最小 25 步。

---

### 6. 步间延迟

| | site-use | ghost-cursor |
|---|---|---|
| 方式 | 固定 18ms | 动态（基于贝塞尔速度导数 + 总时间分配） |
| 弯曲处 | 与直线处相同 | **自动减速**（步间隔变大） |
| 总时间 | `steps * 18ms`（线性增长） | `moveDelay`（可配置总时间） |

**差距**：固定 18ms 意味着弯曲段和直线段的移动速度一样，真人在方向变化大的地方会减速。

**建议**：⚡ 中优先级。可以后续通过速度导数实现变速，但当前固定延迟已能通过主流检测。

---

### 7. Overshoot（过冲）

| | site-use | ghost-cursor |
|---|---|---|
| 实现 | ✅ 远距离(>500px)先过冲再修正 | ✅ 远距离(>500px)先过冲再修正 |
| 过冲范围 | 120px 半径随机偏移 ✅ | 120px 半径随机偏移 |
| 触发阈值 | `OVERSHOOT_THRESHOLD = 500px` ✅ | `overshootThreshold = 500px` |
| 修正曲线 | 从过冲点到目标再生成一段贝塞尔曲线 ✅ | 从过冲点到目标再生成一段贝塞尔曲线 |
| 过冲停顿 | 40-100ms 随机停顿（模拟 "oops" 反应） | 无显式停顿 |

**~~差距~~** ✅ 已对齐：overshoot 已实现，包含前向角度偏移 + 修正曲线 + 随机停顿。

---

### 8. 其他 ghost-cursor 特性

| 特性 | 说明 | site-use 是否需要 |
|------|------|-------------------|
| 元素感知随机点击位置 | 在元素 bounding box 内随机选点（paddingPercentage） | ❌ 已有 `applyJitter` ±3px |
| 重试逻辑 | 点击失败时最多重试 10 次 | ❌ 不需要（site-use 有遮挡检测） |
| 滚动速度指数缩放 | 滚动距离越大速度越快 | ❌ 不相关（scroll 是独立原语） |

---

## 改进优先级排序

| 优先级 | 项目 | 改动量 | 状态 | 说明 |
|--------|------|--------|------|------|
| **高** | Overshoot 过冲 | 中 | ✅ 已完成 | 远距离(>500px)先过冲再修正，120px 半径随机偏移 + 修正曲线 |
| **高** | 步数改用对数公式 | 低 | ✅ 已完成 | Fitts' Law `log₂(d/10+1)`，最小 25 步 |
| **高** | Spread clamp | 极低 | ✅ 已完成 | `Math.max(2, Math.min(200, distance * 0.3))` |
| **中** | 弯道减速（速度导数） | 中 | 待实现 | 贝塞尔导数计算 + 变速延迟 |
| **低** | 控制点位置随机化 | 低 | 待实现 | 从固定 0.25/0.75 改为随机选点 |

---

## site-use 的独有优势

ghost-cursor 不具备但 site-use 已实现的：

| 特性 | 说明 |
|------|------|
| `injectCoordFix()` | screenX/screenY 坐标修复，ghost-cursor 未处理 |
| `checkOcclusion()` | 点击前遮挡检测 + 回退，ghost-cursor 仅重试 |
| `waitForElementStable()` | CSS 动画等待，ghost-cursor 未处理 |
| 环境变量可配置 | 每个增强可单独开关 |

---

## 结论

site-use 的自研方案在**防御层面**（坐标修复、遮挡检测、动画等待）优于 ghost-cursor。**行为模拟层面**三个高优先级项（overshoot、Fitts' Law 步数、spread clamp）已全部补齐，剩余差距为中/低优先级的弯道减速和控制点随机化。
