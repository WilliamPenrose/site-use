# CLI for LLM 设计方案

## 核心理念

site-use 同时服务两类消费者：人类用户和 LLM agent。实践发现 **CLI 对两者同样优** —— 输出对用户可见、可审计、无黑盒。

设计原则：**纯 CLI 架构，去掉 MCP。**

理由：
- CLI 通过 Bash 工具调用，输出对用户和 LLM 都透明
- MCP 层是架构顶层薄壳，与 CLI 共享全部底层（wrapToolHandler、plugins、primitives）
- 去掉 MCP 减少一套代码路径，维护更简单
- 未来如需 MCP，可低成本重新引入（只需加一个 server.ts 调 wrapToolHandler）

## 输出格式

统一 JSON。去掉人类可读格式（human-readable formatter）。

理由：
- JSON 在嵌套结构（reply chain、quote tweet）上保留层级关系，人类格式会丢失
- LLM 本身就是最好的文本处理器 —— 它能从 JSON 中提取、过滤、总结，不需要 jq
- 一种格式，零歧义

## 时区

所有 timestamp 使用 **本地时区 ISO 8601**（如 `2026-03-29T10:03:00+08:00`），不使用 UTC。

理由：
- 用户说的时间永远是本地时间（"今天"、"昨天下午"）
- LLM 跨时区转换容易出错，尤其跨日边界
- 减少一层转换 = 减少一个出错点

## 多媒体

CLI 是文本管道，无法内联展示图片。解决方案：

**screenshot 作为 CLI 命令实现**，输出文件路径：

```
npx site-use screenshot --site twitter
→ {"screenshot": "~/.site-use/screenshots/twitter.png"}
```

- 固定路径，每次覆盖，无需清理
- LLM 通过 Read 工具查看图片文件

## 错误处理

- 错误 JSON 始终包含 `type`、`message`、`hint`、`trace`
- 不需要 `--debug` 也能看到 trace（仅在成功时 trace 需要 `--debug`）
- 错误时 LLM 可调 `npx site-use screenshot` 诊断页面状态

## 去掉 MCP 的影响

需要删除：
- `src/server.ts` — MCP server 入口
- `src/server-global-tools.ts` — MCP 全局工具
- `src/server-resources.ts` — MCP resources
- `generateMcpTools()` — codegen 里的 MCP 工具生成
- `index.ts` 里的 `mcp` 子命令
- `@modelcontextprotocol/sdk` 依赖

不受影响：wrapToolHandler、plugins、primitives、browser、storage —— 全部完好。

## 实现状态

1. ~~去掉 MCP 层（删除上述文件和依赖）~~ ✓
2. ~~CLI search 去掉人类可读格式，默认 JSON~~ ✓
3. ~~JSON timestamp UTC → 本地时区~~ ✓
4. ~~新增 `npx site-use screenshot` CLI 命令~~ ✓
