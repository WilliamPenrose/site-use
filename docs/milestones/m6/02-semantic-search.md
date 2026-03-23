# M6 阶段 2：语义检索 + 混合融合

> 上游：[00-raw-data-archive.md](00-raw-data-archive.md)
> 前置：[01-storage-and-search.md](01-storage-and-search.md)（阶段 1 必须完成）
> 状态：待设计
> 日期：2026-03-23

## 解决的问题

"最近有什么关于 AI agent 的讨论" — 关键词搜不到"大模型自主决策能力越来越强"的推文。

## 目标

在阶段 1 的基础上加入本地 embedding 和向量搜索，实现语义级别的检索。搜索自动升级为混合模式（向量 + FTS + 结构化），无需用户改变用法。

**核心约束不变：** 零外部服务、零 API 调用。Embedding 由 transformers.js 在进程内完成。

## 新增依赖

- `@huggingface/transformers` — 本地 ONNX 推理，进程内运行 embedding 模型
- `sqlite-vec` — SQLite 向量搜索扩展

## 交付物

| 交付物 | 说明 |
|--------|------|
| `src/storage/embedding.ts` | transformers.js 封装 + embedding 缓存 + 异步计算 |
| `src/storage/query.ts` 扩展 | 向量 KNN + 混合融合（向量 + FTS + 结构化）+ MMR + 时间衰减 |
| `src/storage/schema.ts` 扩展 | items_vec + embedding_cache + meta 表 |
| CLI rebuild 命令 | `npx site-use rebuild --model bge-small-zh` |
| 测试 | embedding 缓存命中、混合检索排序、模型切换 rebuild、搜索时补算缺失 embedding |

## 核心设计决策

### Embedding 方案：transformers.js

选择 `@huggingface/transformers`（ONNX Runtime），而非 OpenClaw 使用的 `node-llama-cpp`（GGUF）。理由见 [00-raw-data-archive.md — 决策 4](00-raw-data-archive.md)。核心原因：site-use 只需要 embedding 不需要 LLM 推理，transformers.js 的 pipeline API 更适合 embedding 场景。

候选模型：

| 模型 | 维度 | 大小 | 语言 | 说明 |
|------|------|------|------|------|
| snowflake-arctic-embed-xs | 384 | 22M | 英文为主 | GitNexus 使用，最轻量，默认选择 |
| bge-small-zh-v1.5 | 512 | 95M | 中英双语 | 推文含中文时的升级选择 |
| bge-m3 | 1024 | 567M | 100+ 语言 | 多语言最强，中英混合推文的最佳选择 |
| nomic-embed-text-v1.5 | 768 | 137M | 多语言 | 质量好，体积适中 |

模型首次运行自动下载缓存到 `~/.site-use/models/`，之后离线可用。换模型只改配置，但**向量维度不同，需要 rebuild**。

### 写入时机

```
twitter_timeline 返回
  ├── 同步：INSERT items + FTS5（阶段 1 已有，不改）
  ├── 同步：返回结果给 agent
  └── 异步：计算 embedding → 写入 items_vec
```

原始数据写入不变。Embedding 异步计算，丢了无所谓——下次搜索时检测到缺失的 embedding，补算即可（参考 OpenClaw 的 sync on search 模式）。

### 混合检索管线（参考 OpenClaw）

```
store.search({ query: "AI agent 发展趋势", author: "elonmusk" })
  │
  ├── 并行：
  │     ├── 向量搜索：embedding(query) → sqlite-vec KNN → top-N 候选
  │     └── FTS 搜索：FTS5 MATCH → BM25 排序 → top-N 候选
  │
  ├── 混合融合：
  │     ├── 按 id 合并两路结果
  │     ├── 加权：vectorWeight × vec_score + textWeight × text_score
  │     ├── 时间衰减：score × exp(-λ × age_days)
  │     └── MMR 重排：平衡相关性 vs 多样性
  │
  ├── 结构化筛选：WHERE author = 'elonmusk'（叠加在混合结果上）
  │
  └── 返回排序后的结果
```

### 模型切换与 rebuild

- `items` 表 `embedding_model` 字段记录每行使用的模型
- `embedding_cache` 表按 `(model, content_hash)` 缓存，避免重复计算
- `npx site-use rebuild --model bge-small-zh`：批量重新计算所有 embedding
- `meta` 表记录当前模型、维度、最后 rebuild 时间

### 对阶段 1 的零改动

- items/twitter_meta/关联表/FTS5 — 不动
- 存储接口 `KnowledgeStore` — 不动
- CLI search 参数 — 兼容，`query` 参数自动走混合检索
- 写入流程 — 同步路径不变，只追加异步 embedding

## 待设计

- [ ] 默认 embedding 模型选择（英文场景 vs 中英混合场景）
- [ ] 混合检索权重调优（推文场景 vs OpenClaw 文档场景，推文更短，向量权重可能要调高）
- [ ] 时间衰减半衰期（推文时效性比文档更强，可能 < 30 天）
- [ ] MMR 参数 λ（OpenClaw 用 0.7，推文场景是否需要调整）
- [ ] embedding 异步计算的具体实现（Worker thread? 进程内队列?）
- [ ] rebuild 的进度反馈（批量处理几千条时的用户体验）
- [ ] 存储容量管理（过期策略 / 归档 / 上限）
- [ ] 搜索时补算缺失 embedding 的触发条件和性能影响
