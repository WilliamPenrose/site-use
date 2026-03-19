# site-use vs Scrapling 深度对比分析

> 日期：2026-03-18
> 用途：从 site-use 视角审视 Scrapling 的核心能力，重点关注"自适应网站改版"和"反检测"两个维度，识别可借鉴的设计

## 前提说明

两者定位不同：
- **Scrapling** 是通用爬虫框架（Python），目标是"抓取任意网站的数据"
- **site-use** 是站点专属浏览器自动化工具（TypeScript），目标是"作为用户的代理操作特定平台"

因此本文不做"谁更好"的评判，而是聚焦：**Scrapling 有哪些核心能力值得 site-use 借鉴？**

---

## 一、自适应网站改版能力（核心对比）

### 1.1 总体策略对比

| 维度 | site-use | Scrapling |
|------|----------|-----------|
| **核心思路** | ARIA 语义匹配——绑定无障碍属性，而非 DOM 结构 | 元素指纹 + 相似度匹配——多维特征比对，自动重定位 |
| **应对改版的方式** | 赌网站不会改 ARIA（合规约束） | 不赌任何一个属性不变，而是综合所有特征做概率匹配 |
| **人工介入时机** | ARIA 属性变化时需更新 matchers.ts | 相似度低于阈值时需人工确认 |
| **持久化** | 无（规则硬编码在 matchers.ts） | SQLite 存储元素指纹，按域名分库 |
| **学习能力** | 无 | 有——`auto_save=True` 首次保存指纹，后续 `adaptive=True` 自动匹配 |

### 1.2 Scrapling 的元素指纹系统（重点剖析）

这是 Scrapling 最独特的能力，值得深入理解。

**指纹采集维度**（`element_to_dict`）：

```
元素本体：tag, attributes, text
位置信息：DOM 路径（祖先标签序列）
家族信息：parent tag/attributes/text, sibling tags, children tags
特殊属性：class, id, href, src 单独处理
```

**相似度计算**（`__calculate_similarity_score`）：

用 `difflib.SequenceMatcher` 对每个维度做 0-1 的相似度评分：
1. 标签名完全匹配（0 或 1）
2. 文本内容相似度
3. 属性字典的 key/value 各 0.5 权重
4. class、id、href、src 专项相似度
5. DOM 路径序列相似度
6. 父元素特征相似度
7. 以上取平均 → 最终得分

**重定位流程**（`relocate`）：
1. 原选择器失败
2. 遍历页面所有元素
3. 逐一计算与"旧指纹"的相似度
4. 返回得分最高且 ≥ 阈值的元素

### 1.3 两种策略的优劣分析

**site-use 的 ARIA 语义匹配：**
- ✅ 简单直接，无需持久化
- ✅ 对 Twitter 等大厂高度有效（ARIA 受无障碍法规保护）
- ❌ 只适用于有良好无障碍支持的网站
- ❌ 不可迁移——换一个 ARIA 支持差的网站就失效
- ❌ 无自愈能力——属性一变就需要手动修复

**Scrapling 的指纹相似度匹配：**
- ✅ 通用性强——不依赖任何单一属性
- ✅ 有自愈能力——只要整体特征足够相似就能重新找到
- ✅ 可量化——相似度得分可以设阈值，可以返回候选列表
- ❌ 计算开销大——遍历全部元素 × 多维比对
- ❌ 可能产生误匹配——相似的元素（如列表中多个同结构项）
- ❌ 需要"首次学习"步骤来建立指纹

### 1.4 💡 对 site-use 的借鉴价值

**核心决策：ARIA 语义匹配为主，指纹相似度 fallback 为辅，双层防御网站改版。**

确定采纳的设计：

1. **元素指纹 Fallback 机制**：当 ARIA 匹配失败时（`ElementNotFound`），不直接报错，而是：
   - 从 SQLite 中读取该元素之前保存的多维指纹
   - 遍历当前页面元素，计算相似度得分
   - 返回候选列表 + 置信度，由 caller（Skill/AI）决定是否采用
   - 契合 site-use 的"检测不恢复"设计哲学——把候选交给 caller

2. **自动指纹保存（auto_save）**：workflow 每次 ARIA 匹配成功时，顺手将元素的多维指纹写入 SQLite。零运行时成本，持续为 fallback 积累数据。

3. **SQLite 持久化**：用 `better-sqlite3` 存储元素指纹，按域名分表。对用户零感知（就是一个本地文件），天然支持查询、索引、并发写入。

4. **`find_similar` 列表提取**：Timeline 中多条 Tweet 结构相同，借鉴 Scrapling 的 `find_similar`（同深度 + 同标签层级 + 属性阈值匹配）辅助列表场景。不过 site-use 用辅助功能树的 `role: 'article'` 已能覆盖大部分情况，`find_similar` 作为补充手段。

**备注**：全量遍历比对的性能开销在 site-use 场景下不是问题（只匹配少量关键元素）。

---

## 二、反检测能力（核心对比）

### 2.1 总体策略对比

| 维度 | site-use | Scrapling |
|------|----------|-----------|
| **核心思路** | 用真实浏览器环境，让一切指纹天然真实 | 用技术手段伪造/隐藏自动化特征 |
| **浏览器** | 用户本地真实 Chrome（`channel: 'chrome'`） | Patchright（Playwright 改装版）或真实 Chrome |
| **Profile** | 独立持久化 Profile（有历史、登录态） | 默认临时 Profile，可选持久化 |
| **进程模型** | 常驻——Chrome 不随 server 退出 | 按需启动/关闭 |

### 2.2 Scrapling 的反检测技术栈

Scrapling 提供三个抓取器（Fetcher），反检测能力逐级递增：

**Level 1：Fetcher（纯 HTTP）**
- TLS 指纹模拟（模仿真实浏览器的 TLS 握手）
- 使用 `browserforge` 生成真实的 User-Agent 和 Headers

**Level 2：DynamicFetcher（Playwright 内核）**
- 标准 Playwright 浏览器自动化
- 可选 `real_chrome=True` 使用本地 Chrome
- 可选 `user_data_dir` 持久化 Profile

**Level 3：StealthyFetcher（Patchright + 全套隐身）**
- 使用 Patchright（Playwright 的 stealth fork），从底层 patch 了自动化检测
- Cloudflare Turnstile 自动解决
- 完整的启动参数隐身：

```
反检测启动参数（STEALTH_ARGS）：
├── 自动化隐藏：--disable-blink-features=AutomationControlled
├── 同步优化：--enable-surface-synchronization
├── 后台服务禁用：减少异常网络请求
├── 网络优化：--enable-tcp-fast-open
├── 图形：--force-color-profile=srgb, --ignore-gpu-blocklist
└── 语言：--lang=en-US
```

**JavaScript 层面的反检测**：
- Canvas 指纹防护：注入随机噪声到 Canvas 操作（`--fingerprinting-canvas-image-data-noise`）
- WebRTC 泄露防护：禁用非代理 UDP（`--webrtc-ip-handling-policy=disable_non_proxied_udp`）
- WebGL 可选禁用（但不建议——WAF 会检测）

**Cloudflare 自动绕过**：
- 检测挑战类型（非交互式/管理式/交互式/嵌入式）
- 等待页面稳定（network idle）
- 模拟人类鼠标点击（100-200ms 随机延迟）
- 处理嵌入式 iframe 挑战
- 递归重试

### 2.3 两种反检测策略的对比

| 维度 | site-use（真实环境派） | Scrapling（技术伪装派） |
|------|----------------------|----------------------|
| **指纹一致性** | 天然一致——真实浏览器 | 需要多层伪装保持一致 |
| **维护成本** | 低——浏览器更新自动带来新指纹 | 高——反检测手段需要跟进 WAF 更新 |
| **被检测风险** | 低——与正常用户无法区分 | 中——伪装可能有遗漏 |
| **适用范围** | 仅限本地运行 | 可在服务器/容器中运行 |
| **并发能力** | 受限于本地 Chrome 实例 | 可以起多个浏览器上下文 |
| **无头模式** | 不支持（设计选择） | 支持 |

### 2.4 💡 对 site-use 的借鉴价值

**核心结论：site-use 的"真实浏览器"策略在本地场景下是最优解，Scrapling 的大部分反检测技术在此前提下不需要。**

但有几点值得关注：

1. **WebRTC 泄露防护**：即使用真实 Chrome，如果用了代理，WebRTC 仍可能泄露本机真实 IP。Scrapling 的 `--webrtc-ip-handling-policy=disable_non_proxied_udp` 值得采纳到 browser.ts 的启动参数中——**当且仅当配置了代理时**。

2. **Cloudflare 挑战检测**：虽然 Twitter 目前不用 Cloudflare，但如果 site-use 未来扩展到其他站点（如部分新闻站），Scrapling 的 Cloudflare 检测 + 等待 + 模拟点击流程是个好参考。可以作为 Sites 层的可选中间件。

3. **Canvas 指纹噪声**：真实 Chrome 的 Canvas 指纹是固定的，这意味着跨站点可以关联追踪同一用户。如果 site-use 未来需要多账号场景，Scrapling 的 Canvas 噪声注入思路值得考虑。**但当前单账号场景下不需要。**

4. **`browserforge` 的 Header 生成**：site-use 的 `interceptRequest` 原语如果需要直接发 HTTP 请求（而非通过浏览器），可以参考 Scrapling 用 `browserforge` 生成与浏览器版本匹配的 Headers 的做法。

**明确不需要借鉴的**：
- Patchright：site-use 用真实 Chrome，不需要 Playwright 的 stealth fork
- TLS 指纹模拟：真实 Chrome 的 TLS 指纹就是真的
- `--disable-blink-features=AutomationControlled`：site-use 已经用去除 `--enable-automation` 的方式实现了
- STEALTH_ARGS 中大部分参数：真实浏览器环境下多余

---

## 三、真实 Chrome 使用方式对比

| 维度 | site-use | Scrapling |
|------|----------|-----------|
| **启用方式** | 默认——`channel: 'chrome'` | 可选——`real_chrome=True` 参数 |
| **Profile** | 独立 `user-data-dir`，持久化 | 默认临时，可选 `user_data_dir` |
| **CDP 连接** | Puppeteer 直接管理 | 支持 `cdp_url` 外部连接 |
| **生命周期** | 常驻——不随 server 退出 | 按 session 管理 |
| **多页面** | `Map<site, Page>` 按站点管理 | PagePool 并发管理 |

### 💡 Scrapling 的 CDP 外部连接模式

Scrapling 支持通过 `cdp_url` 连接到已运行的 Chrome 实例。这个模式在知识库踩坑文档中有详细记录：

> **坑 2：CDP 模式不复用已有浏览器 session**——Scrapling 通过 CDP 连接时会创建新的浏览器上下文，不共享已登录的 cookie。解决方案是"混合架构"：用 Playwright 直接连接管理 session，用 Scrapling 只做解析。

site-use 目前用 Puppeteer 直接启动和管理 Chrome，回避了这个问题。但如果未来要支持"连接用户已打开的 Chrome"的场景，需要注意这个陷阱。

---

## 四、其他值得关注的 Scrapling 特性

### 4.1 `find_similar`——结构相似元素发现

```python
# 找到一个商品卡片后，自动找到所有结构相似的卡片
product = page.css('.product-card', auto_save=True)
similar_products = product.find_similar()
```

原理：同 DOM 深度 + 同标签层级（tag + parent + grandparent） + 属性阈值匹配。

**对 site-use 的价值**：Timeline 中的 Tweet 列表、搜索结果列表等场景可以借鉴。但 site-use 用辅助功能树的 role 属性来识别重复结构（如 `role: 'article'`），已经能达到类似效果。

### 4.2 三层抓取器选型

Scrapling 的 Fetcher / DynamicFetcher / StealthyFetcher 分层设计值得欣赏——让用户根据目标网站的反爬强度选择最经济的方案。site-use 只需要一个层级（因为对接的是 Twitter 这样的高防护站点），但如果未来扩展到多个站点，可以考虑类似的分级策略。

### 4.3 Spider 框架的断点续爬

Scrapling 的 Spider 类支持断点续爬——中断后从上次位置继续。site-use 当前是 MCP 工具粒度的操作，不涉及长链路爬取，但如果实现"批量获取某人所有历史推文"这样的需求，断点续爬的思路值得参考。

---

## 五、总结：可执行的借鉴清单

### 确定纳入设计的特性

| 编号 | 特性 | 来源 | 落地位置 | 优先级 |
|------|------|------|---------|--------|
| S1 | 指纹 Fallback + SQLite 持久化 | Scrapling auto_save + relocate + SQLite | 新增 fingerprint 模块 | 高——核心防御能力 |
| S2 | 自动指纹保存（auto_save） | Scrapling auto_save | workflow 匹配成功后钩子 | 高——与 S1 配套 |
| S3 | WebRTC 泄露防护（代理模式下） | Scrapling stealth args | browser.ts 启动参数 | 中 |
| S4 | Cloudflare 挑战处理 | Scrapling cloudflare_solver | Sites 层可选中间件 | 中——扩展新站点时启用 |
| S5 | Canvas 指纹噪声 | Scrapling canvas fingerprint defense | browser.ts 启动参数 | 中——多账号场景需要 |

### 明确不需要的

- Patchright / TLS 指纹模拟 / 大部分 STEALTH_ARGS → 真实浏览器环境下多余
- browserforge → 不直接发 HTTP，浏览器自带真实 Headers
- 三层抓取器分级 → site-use 始终是全功能浏览器模式
