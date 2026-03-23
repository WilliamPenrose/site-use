# M6：原始数据存储（Raw Data Archive）

> 状态：设计讨论阶段
> 日期：2026-03-23
> 依赖：M1（Twitter timeline 抓取能力）

## 定位

site-use 是**原始数据的忠实记录者**，不是智能知识库。

### 分级存储模型

```
上层：OpenClaw 等 Agent
  → LLM 提炼后的知识（摘要、洞察、决策）
  → 量小，成本高，有信息损失
  → 上层随时可回到下层查原始数据，用新 prompt/新模型重新理解

下层：site-use（本层）
  → 原始结构化数据（完整推文、作者、时间、指标）
  → 量大，零成本，无损保存
  → 不做 LLM 加工，但提供足够丰富的索引让上层能高效定位
```

**核心约束：零外部服务、零 API 调用。** 全部存储和检索在进程内完成。

---

## 调研结论

### 社区全景

Agent-friendly 知识存储领域的头部项目：

| 项目 | Stars | 架构 | 评估 |
|------|-------|------|------|
| **Mem0** | ~48K | 向量DB + 图DB + KV 三重存储 | 社区最大，有官方 TS 版 (`mem0ai` npm)，但核心依赖 LLM 做事实提取/去重（每次 add 至少 2 次 LLM 调用） |
| **Graphiti/Zep** | ~24K | Neo4j 时序知识图谱 | 时间感知最强，但强依赖 Neo4j 服务 |
| **Letta (MemGPT)** | ~21K | OS 式三层内存 | Agent 自主管理记忆，概念优雅但复杂 |
| **Cognee** | ~12K | LanceDB(向量) + Kuzu(图) | 默认零外部依赖，但 Kuzu 已于 2025.10 被 Apple 收购后废弃 |
| **Khoj** | ~33K | Django + PostgreSQL + RAG | 最成熟的"第二大脑"，但偏人类交互 |
| **Hindsight** | 新项目 | 仿生记忆 | retain/recall/reflect 三操作，准确率 91.4% |

### 本地参考项目

| 项目 | 存储后端 | 混合检索 | 借鉴点 |
|------|---------|---------|--------|
| **OpenClaw** | SQLite + FTS5 + sqlite-vec | 向量KNN + BM25 + 加权融合 + MMR + 时间衰减 | **直接参考对象** — schema 设计模式、检索管线、embedding 缓存、模型切换机制 |
| **GitNexus** | LadybugDB 嵌入式图数据库 | BM25 + 语义搜索 + RRF 融合 | 模式参考（嵌入式DB + MCP 暴露），但 LadybugDB 是内部组件不可复用 |

### 关键设计决策

#### 1. 不用 Mem0 的 LLM 管线

Mem0 的核心：用 LLM 提取 facts → 向量检索已有记忆 → LLM 判断 ADD/UPDATE/DELETE。

不适合 site-use 原始数据层的原因：
- **推文本身已是结构化数据** — 不需要 LLM 提取
- **每次 add 至少 2 次 LLM 调用** — 违反"零 API 成本"约束
- **原始数据层的价值在于不加工** — LLM 提炼是上层 agent 的职责

> Mem0 官方 TS 版 (`mem0ai` npm) 核心管线仅 1,478 行，prompt 是壁垒而非代码。未来上层 agent 需要时可按需引入其去重逻辑。

#### 2. 不用外部服务

- Neo4j — 服务端数据库，需要 Docker 或独立安装
- Ollama — 独立服务进程，不是库
- Kuzu — 2025.10 被 Apple 收购后 GitHub 仓库已 archive，不再维护

#### 3. 不用独立图数据库

推文的关系（author→tweet、tweet→mention、tweet→hashtag）是简单的一对多，用 SQLite 外键 + JOIN 即可。不需要图遍历或多跳推理。

#### 4. Embedding 本地化：transformers.js（非 node-llama-cpp）

OpenClaw 的本地 embedding 使用 `node-llama-cpp`（GGUF 格式），site-use 选择 `@huggingface/transformers`（ONNX 格式）。两者对比调研后的结论：

| 维度 | transformers.js (ONNX) | node-llama-cpp (GGUF) |
|------|----------------------|----------------------|
| **安装** | 预编译二进制，零编译 | 预编译二进制，偶有 cmake 回退 |
| **API** | pipeline 抽象，批量支持，模型自动下载 | 显式 load → context → 逐条 embed，需手动下载 |
| **Windows GPU** | CUDA + DirectML（AMD/Intel 也行） | CUDA + Vulkan（无 DirectML） |
| **维护方** | HuggingFace 官方（~15.6K stars） | 社区 withcatai（~2K stars） |
| **sqlite-vec 集成** | 输出 Float32Array，直接用 | 需 number[] → Float32Array 转换 |

选择 transformers.js 的理由：
- **site-use 只需要 embedding，不需要 LLM 推理。** node-llama-cpp 的强项是 LLM 推理，embedding 是附带功能，API 设计不如 transformers.js 顺手。
- **GitNexus 已在用 transformers.js**，有实际运维经验。
- **bge-m3 (ONNX) 已覆盖中英混合需求。** node-llama-cpp 独有的 Qwen3-Embedding（MTEB 第一）0.6B 起步，对推文检索杀鸡用牛刀。
- **与 OpenClaw 不一致不是问题。** OpenClaw 选 node-llama-cpp 是因为同时需要 LLM 推理能力。

候选 embedding 模型：

| 模型 | 维度 | 大小 | 语言 | 说明 |
|------|------|------|------|------|
| snowflake-arctic-embed-xs | 384 | 22M | 英文为主 | GitNexus 使用，最轻量，默认选择 |
| bge-small-zh-v1.5 | 512 | 95M | 中英双语 | 推文含中文时的升级选择 |
| bge-m3 | 1024 | 567M | 100+ 语言 | 多语言最强，ONNX 和 GGUF 两边都有 |
| nomic-embed-text-v1.5 | 768 | 137M | 多语言 | 质量好，体积适中 |

**不同模型向量维度不同，换模型需要重新生成所有已存向量。**

---

## 架构设计

### 技术栈

```
site-use MCP Server
  └── Storage Layer (新增)
       ├── transformers.js     — 本地 embedding（纯库，ONNX 推理）
       ├── node:sqlite         — 关系存储 + FTS5 全文搜索（Node.js 22+ 内置，零依赖，与 OpenClaw 一致）
       └── sqlite-vec          — 向量搜索（SQLite 扩展）
```

全部进程内、单文件存储、零服务依赖。

### 与 OpenClaw 的逐项对比

| 维度 | OpenClaw | site-use M6 | 差异原因 |
|------|----------|-------------|---------|
| **数据源** | Markdown 文件 + 会话 JSONL | 推文（site-use 抓取的结构化数据） | 数据来源不同 |
| **摄入触发** | 文件系统监视(chokidar) + hash 对比 + 定时 + 搜索时触发 | `twitter_timeline` 调用后主动写入 | M6 无文件系统，数据从抓取来，更简单 |
| **分块** | 按 token 滑动窗口（400 token/chunk，80 overlap） | **不需要分块** — 一条推文就是一个存储单元 | 推文天然是短文本 |
| **结构化字段** | 无（纯文本 chunks） | author、timestamp、metrics、hashtags、mentions | 推文自带结构，支持 SQL 筛选 |
| **Embedding 提供商** | OpenAI / Gemini / Voyage / Mistral / Ollama / 本地 GGUF（6 种） | **仅 transformers.js 本地 ONNX** | 零 API 成本约束 |
| **Embedding 缓存** | `embedding_cache` 表，按 (provider, model, hash) 去重 | **同样需要** — 按 (model, content_hash) 去重 | 复用设计，简化 key（只有本地提供商） |
| **模型切换** | chunks 表 `model` 字段 + 查询时 `WHERE model = ?` | **同样需要** | 直接复用设计 |
| **FTS5** | 有，多语言停用词 + 中文 bigram | **同样需要** | 复用设计，推文场景更需要中文支持 |
| **向量搜索** | sqlite-vec + JS cosine fallback | **同样需要** | 直接复用 |
| **混合融合** | vectorWeight 0.6 + textWeight 0.4 | **复用**，权重待调优 | 推文更短，向量权重可能要调高 |
| **MMR 去重** | λ=0.7（70% 相关性，30% 多样性） | **复用** | 直接复用 |
| **时间衰减** | 从文件路径/mtime 提取日期，半衰期 30 天 | 从推文 `timestamp` 字段取，半衰期待定 | 推文时效性可能更强 |
| **去重** | 文件级 hash 对比 | **推文 id 去重** — 同一推文多次抓取不重复存 | 更简单，tweet.id 是天然主键 |
| **增量同步** | 复杂（文件监视 + session delta 追踪 + 脏标记） | **不需要** — 写入时机确定（抓取后立即写入） | M6 场景更简单 |
| **LLM 调用** | 摄入和查询都不调 | **同样不调** | 一致 |
| **MCP 工具** | `memory_search(query)` + `memory_get(path)` | `knowledge_search(query, filters?)` — 增加结构化筛选 | M6 需要按作者/时间/标签筛选 |

### 数据摄入

一条推文天然自带结构化数据，不需要 LLM 或分块：

```
Tweet (site-use 已有类型)
  ├── id                                → 主键，天然去重
  ├── text                              → FTS5 全文索引 + embedding 语义索引
  ├── timestamp                         → 时间筛选 + 时间衰减权重
  ├── url                               → 存储，不索引
  ├── author: { handle, name }          → 结构化筛选（WHERE author_handle = ?）
  ├── metrics: { replies, retweets, likes, views } → 存储，可按热度排序
  ├── @mentions (从 text 正则提取)       → 关联表（tweet_mentions）
  ├── #hashtags (从 text 正则提取)       → 关联表（tweet_hashtags）
  ├── isRetweet, isAd                   → 过滤标记
  └── raw_json                          → 完整原始数据，零信息损失
```

**LLM 级别的理解（观点提取、因果分析、主题归类）延迟到查询时由上层 agent 按需进行。**

### 检索模式

三种检索 + 混合融合，参考 OpenClaw 管线：

1. **语义搜索** — embedding → sqlite-vec 向量 KNN（"关于 AI agent 的讨论"能找到"大模型自主决策"）
2. **关键词搜索** — FTS5 + BM25（精确匹配兜底）
3. **结构化查询** — SQL WHERE（按作者/时间范围/标签/热度筛选）— OpenClaw 没有，M6 新增
4. **混合融合** — 加权合并 + MMR 去重 + 时间衰减

### Agent 接口

CLI 子命令（与 gitnexus 同模式），agent 通过 shell 调用：

```bash
npx site-use search "AI agent" --author elonmusk --since 2026-03-01 --json
npx site-use stats --json
npx site-use rebuild --model bge-small-zh        # Phase 2
```

- 默认输出人类可读格式，`--json` 输出结构化 JSON
- 错误输出到 stderr，带 `hint` 字段指引 agent 下一步操作
- 存储在 `twitter_timeline` 内部自动触发，对 agent 透明

---

## 存储位置

```
~/.site-use/
  ├── chrome-profile/          # M1 已有
  ├── data/                    # M4 已预留
  │   ├── fingerprints.db      # M4
  │   └── knowledge.db         # M6 — SQLite (文档 + 向量 + FTS + 结构化)
  └── models/                  # M6 — transformers.js 模型缓存
```

单个 `knowledge.db` 文件包含所有表（推文、关联、FTS5 虚拟表、sqlite-vec 向量表、embedding 缓存、元数据）。

---

## 阶段拆分

两阶段递进，每阶段独立可用：

| 阶段 | 文档 | 解决的问题 |
|------|------|-----------|
| Phase 1 | [01-storage-and-search.md](01-storage-and-search.md) | 存储 + 去重 + FTS5 关键词搜索 + 结构化筛选 + CLI |
| Phase 2 | [02-semantic-search.md](02-semantic-search.md) | embedding + 向量搜索 + 混合融合 + MMR + 时间衰减 + rebuild |
| 场景验证 | [03-scenario-validation.md](03-scenario-validation.md) | 9 个真实使用场景模拟，验证设计完备性 |

### 已解决的设计问题

- [x] 详细 SQLite schema — 见 Phase 1 spec
- [x] 接口定义 — CLI 子命令（`npx site-use search/stats/rebuild`），不是 MCP 工具
- [x] `twitter_timeline` 触发存储 — 原始数据同步写入（~50ms），embedding 异步（Phase 2）
- [x] 通用 vs Twitter 专用 — Class Table Inheritance：共享 `items` 主表 + 站点专属 `twitter_meta`
- [x] 去重策略 — `(site, id)` 主键 + INSERT OR IGNORE
- [x] 模块架构 — 独立 `src/storage/` 模块，可插拔接口，CLI 和 MCP Server 共享

### 待设计（Phase 2）

- [ ] embedding 模型的默认选择（snowflake-arctic-embed-xs 还是 bge-small-zh）
- [ ] 混合检索的权重调优（推文场景 vs OpenClaw 文档场景）
- [ ] 时间衰减半衰期（推文时效性 vs 文档时效性）
- [ ] rebuild 命令设计（模型切换时批量重新 embedding）
- [ ] 存储容量管理（过期策略 / 归档 / 上限）

---

## 趋势备忘

> 来自调研，供后续设计参考

1. **MCP 是 2025-2026 Agent 记忆的标准接口** — Mem0/Graphiti/Hindsight/Basic Memory 都提供 MCP 服务器，与 site-use 架构一致
2. **时间感知是重要维度** — Graphiti 的双时态模型（事件时间 + 摄入时间）值得参考
3. **本地优先（Local-First）是个人知识系统的关键要求** — 与 site-use 的设计哲学一致
4. **Mem0 的 prompt 是核心壁垒** — 如果未来上层 agent 需要 LLM 级别的记忆管理，优先复用其 prompt 而非代码
5. **嵌入式图数据库生态空白** — Kuzu 废弃后 Node.js 生态没有成熟的嵌入式图DB，简单关系用 SQLite JOIN 即可
