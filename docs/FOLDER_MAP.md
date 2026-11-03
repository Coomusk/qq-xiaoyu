# 目录地图

> 一句话说明每个目录干什么、`scripts/` 的命名约定是什么。
> 架构与数据流见 [ARCHITECTURE.md](ARCHITECTURE.md)；文档索引见 [README.md](README.md)。

## 一、顶层

```
qq-xiaoyu/
├── src/                 桥接内核（Node.js，纯 JS，无原生依赖）
├── scripts/             安装 / 自测 / 探针 / 隐私扫描（不是运行时代码）
├── tools/               运维工具：守护、面板、状态、体检、黑话巡检（Windows/PowerShell 为主）
├── dsh/agent-presets/   两个 DSH preset 的**权威源**
├── plugins/             打进 DSH 的插件：preset bundle 与模式设置
├── public/              浏览器静态资源（控制台单页）
├── roles/               人格卡（运行时读取，即改即生效）
├── docs/                文档
├── examples/            脱敏示例（学习本、群背景、处境摘要）
├── assets/              仓库配图
├── state/               运行时数据（**不入库**）
├── config.json          本地配置（**不入库**，从 config.example.json 复制）
└── config.example.json  配置模板（脱敏占位符）
```

## 二、逐个目录

| 目录 | 作用 | 注意 |
| --- | --- | --- |
| `src/` | 桥接内核：主程序 `bridge.js`、DSH 客户端、三个 MCP server、媒体/搜索/账本/人格卡等共享库；`core/` 是会话路由，`console/routes/` 是逐步拆出的控制台 API | 目录里只应有 `.js` / `.mjs`；`*.bak-*` 一律不入库 |
| `scripts/` | 安装（`setup-dsh.mjs`）、自测（`test-*.mjs`）、探针（`probe-*.mjs`）、校验（`verify-*.mjs`）、工具（`privacy-scan.mjs` / `patch-snowluma-sdk.mjs`） | 命名约定见下 |
| `tools/` | 运维面：`guardian.ps1`（单轮守护）、`panel/`（控制台后端 + 两版前端）、`status.mjs`、`humanize-audit.mjs`（活人感体检）、`slang-nightly.mjs`、`context-guard.ps1` | Windows 专用；桥接本体不依赖它们 |
| `dsh/agent-presets/` | `qq-chat`（一代/简单聊天）与 `qq-chat-v2`（二代仿真）的 preset 源，含工具白名单 | **改完必须**跑 `node scripts/build-agent-preset-patches.mjs` 重新生成 patch，再重启 DSH |
| `plugins/qq-agent-presets` | 把上面两个 preset 生成为 DSH 的 `@deepseek-ai/dsh-agent-preset` 行，并携带 `qq-tool-restrict` 的实现 | 改了要重装/重启 DSH |
| `plugins/qq-mode-console` | 注册 `qq-mode` 设置命名空间（只有 host 半，浏览器 UI 卡片未实现） | 同上 |
| `public/` | `console.html`：控制台单页，无构建步骤 | 只应有一个文件 |
| `roles/` | 人格卡：`<角色名>.md`，文件名即角色名；`README.md` 是格式说明 | 用户内容；`*.bak-*` 不入库 |
| `examples/learning-notes/` | 学习本 / 群背景 / 处境摘要 / 语气素材的**虚构示例** | 真实内容在 `state/`，永远不进仓库 |
| `assets/` | 仓库配图；`deepseek娘.png` 也被 `getSelfImage` 工具用作 AI 形象 | 别加体积大的二进制（视频走 Release 附件） |
| `state/` | 会话映射、运行时状态、学习本、日志、令牌、账本 | **整目录 gitignore**；备份靠 `tools/archive-backups.mjs` |

## 三、`scripts/` 命名约定

| 前缀 | 含义 | 会不会碰真实环境 |
| --- | --- | --- |
| `test-*.mjs` | 离线回归，用临时目录与夹具，不读真实 config、不发 QQ 消息 | 不会 |
| `test-audit*.mjs` | 审计型回归（安全、协议、setup 守卫），由 `npm run test:audit` 汇总跑 | 不会 |
| `probe-*.mjs` | 探针：连真实 DSH / SnowLuma 读协议事实，只读 | **会**（需要本机服务在跑） |
| `verify-*.mjs` | 版本适配核对（如 `verify-dsh-021-adaptation.mjs`） | 只读源码，不联网 |
| `setup-*.mjs` | 安装/初始化，会写 DSH 配置与本地文件 | **会**（幂等，可重复跑） |
| `patch-*.mjs` | 修改依赖或生成产物（`postinstall` 用） | 只动 `node_modules` / `plugins/` |
| `privacy-scan.mjs` | 提交前隐私扫描，规则来自 `privacy-rules.json`（不入库） | 只读 |
| `harden-state-acl.mjs` / `diagnose-acl.mjs` | Windows 上收紧 `state/` 的 ACL | **会**（只动权限） |

## 四、哪些东西不该进仓库

`.gitignore` 已经覆盖，这里说**为什么**：

| 路径 | 原因 |
| --- | --- |
| `config.json` | 含 OneBot token、控制台令牌、真实群号、owner QQ |
| `state/` | 群聊内容、学习本、token 用量、日志、令牌 |
| `audio/` | 个人音频素材 |
| `node_modules/` | 依赖 |
| `*.bak` / `*.bak-*` | 本机备份，会污染全局搜索（曾经的 `bridge.js.bak-*` 被当成模块） |
| `scripts/privacy-rules.json` | 里面写着你机器上的真实标识，只提供 `.example` 模板 |
