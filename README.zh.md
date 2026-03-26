# site-use

[English](README.md)

想让 AI 帮你盯着 Twitter timeline，又怕封号、又嫌贵？

site-use 让你的 agent 像真人一样刷推，自动缓存看过的内容，以最低成本把有价值的信息喂给你。

## 为什么用 site-use

### 不会封号

你的 agent 不是在"爬"Twitter，而是像一个真人一样在刷推。

site-use 使用你自己的 Chrome 浏览器，像真人一样浏览——滚动有加减速、鼠标移动有弧度、点击带抖动、操作之间会停顿。多年来，全网无数反检测项目和平台斗智斗勇，很多曾经有效的策略早已失效。我们持续追踪这场对抗，把当下仍然有效的策略融进 site-use，并内置诊断套件持续验证效果。

### 最低成本

没有 site-use 时，你的 agent 为了滚动一下屏幕，需要：截屏 → 看网页 → 决定下一步操作 → 执行。这些辅助动作消耗的 token 远超推文内容本身。

site-use 把这些浏览动作预先封装好，执行时零 token 消耗。agent 只需要处理最终拿到的推文内容。

一次 feed 抓取只需要几秒——稍有等待是因为刻意模拟真人浏览节奏。

### 过目不忘

所有抓取内容自动存入本地数据库，支持全文搜索，可按作者、日期、互动量、推文类型筛选。抓一次，永远能查。

对比其他方案：

- **普通爬虫/抓取器** 看不到你的专属 timeline，除非你把账号密码交给第三方
- **让 agent 自己去看网页** 不仅贵，还不会帮你缓存，每次都要重新抓
- **Twitter 官方 API** 是最佳选择，推荐有条件的用户优先使用以支持平台发展。site-use 是为暂时负担不起 $200/月的用户提供的替代方案

### 结构化语义

你的 agent 拿到的不是一大坨 HTML，而是有语义的结构化内容：

- **谁**发的（作者、关注关系）
- **什么时候**发的
- **以什么方式**（原创、转推、回复、引用）
- **说了什么**（推文全文）
- **互动数据**（点赞、转推、回复、浏览量）

如果把整个网页丢给大模型，上下文会被大量 HTML 标签占满，真正有价值的内容占比极低——不仅贵，还会让模型降智。site-use 只把有意义的内容喂给 agent。

## 快速上手

### 1. 安装

```bash
git clone https://github.com/WilliamPenrose/site-use.git
cd site-use
pnpm install
pnpm run build
npm link
```

之后在任意目录都可以运行 `site-use --help`。

### 2. 配置 MCP 客户端

以 Claude Desktop 为例，找到配置文件 `claude_desktop_config.json`（Settings → Developer → Edit Config），添加：

```json
{
  "mcpServers": {
    "site-use": {
      "command": "site-use",
      "args": ["mcp"]
    }
  }
}
```

### 3. 登录 Twitter

首次使用时，site-use 会启动一个专属的 Chrome 浏览器，拥有独立的配置文件——你日常浏览器里的 cookie、密码、浏览记录，agent 一概看不到。在这个浏览器中登录你的 Twitter 账号，只需一次。Chrome 的安全机制天然保护了你的账号密码，agent 无法获取。

### 4. 开始使用

对你的 agent 说："帮我看一下 Twitter timeline"，agent 会通过 MCP 调用 site-use 自动完成抓取。

你也可以直接用命令行：

```bash
site-use twitter feed             # 抓取 timeline，有缓存时自动使用缓存
site-use search "关键词"          # 全文搜索
site-use stats                   # 查看数据库统计
```

命令行操作绝对零 token 消耗。

## 架构

```
Browser 层 → Sites 层 → MCP Server + CLI
```

**Browser 层（安全基座）**

独立 Chrome 配置文件隔离用户隐私，启动参数级别的反指纹，行为级别的拟人化，三层防护从底层开始构建信任。

**Sites 层（封装 + 本地私有存储）**

Twitter 专属工作流，直接提取 Twitter 内部的完整数据，不丢失任何信息。抓取内容自动进入本地数据库，你的 Twitter 数据终身归你所有，不经过任何第三方。

**MCP Server + CLI（两种使用方式）**

想方便就让 agent 通过 MCP 操作，花一点 token 换省心；常规操作不想烧 token 就自己用命令行，同一套数据，丰俭由人。

## 路线图

- [x] Twitter timeline 抓取与本地缓存
- [x] 全文搜索与结构化筛选
- [x] 反检测诊断套件
- [ ] Reddit 支持
- [ ] 小红书支持
- [ ] 更多站点（欢迎在 Issues 中投票）

## License

MIT
