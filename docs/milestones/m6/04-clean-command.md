# M6 阶段 4：clean 命令 — 本地数据清理

> 上游：[01-storage-and-search.md](01-storage-and-search.md)、[knowledge-store-design.md](knowledge-store-design.md)
> 状态：设计完成
> 日期：2026-03-25

## 解决的问题

"之前那批抓取 following 关系提取错了，想删掉重新抓，但没有任何清理手段。"

当前 `KnowledgeStore` 只有写入和查询能力，没有删除。唯一的"清理"方式是手动删数据库文件，这会丢失所有数据。需要一个安全的、可控粒度的清理命令。

## 设计原则

1. **无默认参数** — 删除是危险操作，所有参数必须显式指定，不允许零过滤条件
2. **删前备份** — 默认自动导出即将删除的数据到 JSONL 文件，可通过 `--no-backup` 跳过（空间不足时）
3. **交互确认** — 先展示匹配摘要（数量、作者分布、时间范围），用户输入 `y` 后才执行
4. **分批事务** — 每 500 条一个事务，释放写锁避免阻塞并发的 MCP ingest
5. **可中断** — Ctrl+C 安全：已提交批次生效，当前批次自动回滚

## 命令格式

```
site-use clean --site <site> <filters> [--no-backup]
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `--site <site>` | 是 | 目标站点（如 `twitter`） |
| `--before <date>` | 否 | 按推文时间过滤：早于此日期 |
| `--after <date>` | 否 | 按推文时间过滤：晚于或等于此日期 |
| `--ingested-before <date>` | 否 | 按入库时间过滤：早于此日期 |
| `--ingested-after <date>` | 否 | 按入库时间过滤：晚于或等于此日期 |
| `--author <handle>` | 否 | 按作者过滤（`@` 前缀可选） |
| `--no-backup` | 否 | 跳过删前自动备份 |

**约束：** `--site` 必填；`--before`/`--after`/`--ingested-before`/`--ingested-after`/`--author` 至少提供一个。

### 日期格式

所有日期参数接受本地时间，内部通过 `localToUtc()` 转为 UTC ISO 字符串后进行比较。支持的格式与 `search` 命令一致：

- `2026-03-01`（日期，自动补 T00:00）
- `2026-03-01 09`（日期+小时）
- `2026-03-01 09:30`（日期+时分）

## 交互流程

```
$ site-use clean --site twitter --ingested-after 2026-03-20 --ingested-before 2026-03-21

Found 42 items matching filters:
  Site:     twitter
  Authors:  @alice (15), @bob (12), @charlie (8), ... 7 more
  Time:     2025-12-03 08:00 → 2026-02-28 07:59 (UTC+8)

Delete these 42 items? (y/N) y
Backed up to ~/.site-use/backups/clean-2026-03-25T14-30-00.jsonl
Deleting... 42/42 (100%) — done
Deleted 42 items.
```

### 流程说明

1. **预览** — `previewDelete()` 查询匹配数量、作者分布（按数量降序，最多显示 10 个）、时间范围（数据库存储 UTC，展示时转为本地时间并标注时区，如 `UTC+8`）
2. **确认** — 通过 `readline` 提示 `(y/N)`，只有 `y` 才继续
3. **备份** — 除非 `--no-backup`，将匹配项逐行导出为 JSONL（每行包含 `id`、`site`、`author`、`timestamp`、`ingested_at`、`raw_json`）
4. **删除** — 分批执行，每批后显示进度和 ETA（基于已用时间推算）
5. **完成** — 输出最终删除数量

## 为什么需要 `--ingested-before/after`

核心使用场景是"某次抓取有异常，要删掉那批数据"。按推文时间（`--before/--after`）无法精确定位，因为同一天的推文可能分多次抓取，有的正常有的有问题。`items` 表的 `ingested_at` 字段记录了入库时间，按此过滤可以精确定位到某一批次。

## 存储层接口扩展

在 `KnowledgeStore` 接口新增三个方法：

```ts
interface KnowledgeStore {
  // ... 现有方法 ...

  /** 预览匹配的待删除项：数量、作者分布、时间范围 */
  previewDelete(params: DeleteParams): Promise<DeletePreview>;

  /** 导出匹配项为 JSONL，流式回调避免内存问题 */
  exportItems(params: DeleteParams, onLine: (line: string) => void): void;

  /** 分批删除匹配项，支持进度回调 */
  deleteItems(params: DeleteParams, opts?: DeleteOptions): Promise<DeleteResult>;
}
```

### 新增类型

```ts
interface DeleteParams {
  site: string;
  before?: string;         // 推文时间 <
  after?: string;          // 推文时间 >=
  ingestedBefore?: string; // 入库时间 <
  ingestedAfter?: string;  // 入库时间 >=
  author?: string;
}

interface DeletePreview {
  totalCount: number;
  authors: Array<{ handle: string; count: number }>;
  timeRange: { from: string; to: string } | null;
}

interface DeleteProgress {
  deletedSoFar: number;
  totalCount: number;
}

interface DeleteResult {
  deleted: number;
}

interface DeleteOptions {
  batchSize?: number;  // 默认 500
  onProgress?: (progress: DeleteProgress) => void;
}
```

## 分批删除策略

### 为什么要分批

1. **写锁竞争** — SQLite WAL 模式下只允许一个 writer。单事务删除大量数据会长时间持有写锁，阻塞并发的 MCP ingest（`busy_timeout` 5 秒后报错）
2. **内存控制** — 一次加载所有待删 ID 和 text（FTS5 清理需要）会占用大量内存
3. **可中断性** — 每批提交后是一致状态，Ctrl+C 不会损坏数据

### 每批流程

```
循环:
  SELECT id, text FROM items WHERE <filters> LIMIT 500
  如果无结果 → 退出循环
  BEGIN
    DELETE FROM item_metrics  WHERE site=? AND item_id IN (...)
    DELETE FROM item_mentions WHERE site=? AND item_id IN (...)
    DELETE FROM item_hashtags WHERE site=? AND item_id IN (...)
    FTS5 逐条 delete command（UNINDEXED 列不能用 WHERE）
    DELETE FROM items         WHERE site=? AND id IN (...)
  COMMIT
  触发 onProgress 回调
```

### FTS5 删除

FTS5 虚拟表的 UNINDEXED 列不能用在 `DELETE FROM ... WHERE` 中。必须使用 FTS5 的特殊 delete 命令：

```sql
INSERT INTO items_fts(items_fts, text, id, site) VALUES('delete', ?, ?, ?);
```

需要提供被删行的原始 `text` 值，因此每批 SELECT 时同时取出 `text`。

## 自动备份

### 策略

- **默认开启**：确认删除后、执行删除前，自动导出到 `~/.site-use/backups/clean-<ISO timestamp>.jsonl`
- **`--no-backup` 跳过**：适用于磁盘空间不足（空间不足本身就是需要 clean 的原因之一）
- **格式**：JSONL（每行一个 JSON 对象），包含完整的 `raw_json`，可用于恢复

### 备份内容

每行 JSON 包含：

```json
{"id":"...","site":"twitter","author":"alice","timestamp":"2026-03-01T10:00:00Z","ingested_at":"2026-03-25T14:30:00Z","raw_json":"{...}"}
```

`raw_json` 保留完整的原始解析数据，是数据恢复的唯一来源。

## 进度与 ETA

删除过程中通过 `\r` 覆写同一行显示实时进度：

```
Deleting... 1500/4200 (35%) — ETA ~8s
```

ETA 计算：`剩余条数 / (已删条数 / 已用秒数)`。前几批由于缓存预热可能不准，随着批次增多会趋于稳定。

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/storage/types.ts` | 修改 | 新增 `DeleteParams`、`DeletePreview`、`DeleteProgress`、`DeleteResult`、`DeleteOptions` 类型；`KnowledgeStore` 接口新增三个方法 |
| `src/storage/delete.ts` | 新增 | `buildWhereClause()`、`previewDelete()`、`exportItems()`、`deleteItems()` |
| `src/storage/index.ts` | 修改 | 导入并注册新方法到 `createStore()` |
| `src/cli/clean.ts` | 新增 | `parseCleanArgs()`、`formatPreview()`、`formatProgress()`、`runCleanCli()` |
| `src/index.ts` | 修改 | 注册 `clean` 命令路由 |
| `tests/unit/storage-delete.test.ts` | 新增 | 存储层测试：preview、export、delete、级联清理、分批、进度回调 |
| `tests/unit/cli-clean.test.ts` | 新增 | CLI 测试：参数解析、格式化、错误路径 |

## 测试策略

- **存储层**：`:memory:` SQLite 数据库，先 ingest 测试数据再测试 preview/export/delete
- **CLI 层**：`mkdtempSync` 临时目录，纯函数测试（`parseCleanArgs`、`formatPreview`、`formatProgress`）
- **不接触真实数据**：与现有测试模式一致，完全隔离
- **分批验证**：用 `batchSize: 2` 强制多批次，断言进度回调触发次数和累计值

## 不做的事

| 不做 | 理由 |
|------|------|
| 恢复命令（`restore`） | 备份文件是 JSONL，手动恢复或未来再加 |
| 基于 metric 过滤的删除 | 当前场景不需要，保持接口简单 |
| `--yes` / `--force` 跳过确认 | CLI 工具不需要非交互模式，MCP 层如需可直接调存储层 API |
