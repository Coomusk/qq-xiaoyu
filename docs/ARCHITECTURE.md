# 架构

> 这份文档讲**东西怎么连起来**；「怎么装」看 [guides/DSH_SETUP.md](guides/DSH_SETUP.md)，「权限边界」看 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)。

## 1. 三层与职责

```
┌────────────┐   OneBot v11    ┌──────────────┐   Cookie / RPC / mux   ┌──────────────┐
│ SnowLuma   │◄───────────────►│  qq-xiaoyu   │◄──────────────────────►│     DSH      │
│  (网关)     │  WS + HTTP API  │   桥接进程    │  /api/* + 事件流        │  (agent 运行时)│
└────────────┘                 └──────────────┘                        └──────────────┘
      │                               │                                       │
   挂在 QQ 客户端                  准入/节奏/媒体/账本                      会话/工具/审批
   自己的原生 hook                 本地控制台 :3100                        模型
```

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| SnowLuma | QQ 登录、收发、原生 hook | 任何业务逻辑 |
| **桥接（本仓库）** | 准入白名单、会话映射、拆条与节奏、媒体下载归一化、工具面、成本账本、控制台、守护 | 不做推理 |
| DSH | agent 循环、上下文、工具调用、审批、模型选择 | 不认识 QQ |

**设计原则**：桥接是**策略层**，不是推理层。它决定「这条消息要不要惊动 agent」「这条回复该拆成几条」，但不决定「说什么」。

## 2. 一条消息的旅程

### 入站

```
QQ 消息
 └─► SnowLuma  ── message/group | message/private ──►  bridge.js
      ├─ 准入判定：allow/deny 白名单（群/私聊各自独立，空 + allowAllWhenEmpty=false = 丢弃）
      ├─ 规范化：CQ 码 → 纯文本 + 媒体描述（[图片] / [表情包:备注] / [引用 某人：原文]）
      ├─ 媒体：SSRF 防护下载 → 尺寸/像素/张数限流 → 模型可吃的形态（动图取帧拼图）
      ├─ 会话映射：group:<id> / private:<id> → DSH sessionId（state/sessions.json）
      └─ 投递：session/prompt（或排队，DSH 不在时最多 50 条/会话）
```

### 出站

```
DSH assistant/message 事件
 └─► bridge.js
      ├─ 取文本：Markdown → QQ 纯文本（链接变「文字 (url)」）
      ├─ 分条：按模式（一代空格 / 二代数组）+ 长度上限 + 句读边界
      ├─ 节奏：条间随机间隔、长间隔概率、每分钟/每小时发送配额
      └─ 发送：OneBot send_group_msg / send_private_msg（+ replyToMessageId 引用）
```

## 3. 会话模型

- 一个 QQ 会话（群或私聊）= 一个独立的 DSH 会话，统一归到 `workspaceTitle`（默认「QQ 聊天」）工作区
- 映射持久化在 `state/sessions.json`；`state/agents/<key>/` 是每个会话的工作目录
- **key 规范化**：`group:0456` 与 `group:456` 指向同一个会话（`src/core/session-router.mjs` 的 `canonicalConversationKey`）
- 会话失效（DSH 侧被删/被重置）时桥接重建，**不复用旧权限**；模式或 preset 变化也会重建会话
- 每个会话的模型由桥接在 `session.selectModel` 里显式固定（`config.dsh.model`），不依赖 DSH 全局默认

## 4. 唤醒模型（`reserved2`）

二代仿真里，**文本输出不自动转发**——agent 必须调工具才算说话。这意味着「什么时候醒」是桥接的调度问题：

| 唤醒原因 | 触发条件 | 是否受频率限制 |
| --- | --- | --- |
| `atMention` | 被 @ | 否（高优先级豁免） |
| `nameMention` | 消息里出现角色名 | 否 |
| `question` | 问句 | 否 |
| `private` | 私聊 | 否 |
| `poke` | 拍一拍 | 否 |
| `recommended` | 群里有人说话（按概率） | 是 |
| `proactiveCheck` | 冷场很久，给一次主动开话题的机会 | 是 |
| `timeout` | 自己设的有限潜水到期 | 是 |
| `bootstrap` | 会话第一次唤醒（附带初始提示词） | — |

限流是**双桶**（每分钟/每小时），积压超过阈值整批丢弃——这条是踩过坑的：补发死循环会打满限流，之后连 @ 都被挡。

每轮结束 agent 用 `qq_set_wake_config` 决定下一次怎么醒；`qq_wait_for_messages` 提供 5 分钟长轮询的「等人说完」。

## 5. 工具面

QQ 会话拿到的工具来自三个 MCP server（由 `scripts/setup-dsh.mjs` 挂到 DSH）：

| MCP server | 提供 | 边界 |
| --- | --- | --- |
| `snowluma`（`src/mcp-snowluma-safe.js`） | QQ 动作安全子集：查状态/群/成员/历史/未读、发消息、发表情、拍一拍、引用、学习本、黑话 | 发送强制白名单；路径限制在仓库内；不提供任意命令 |
| `snowluma-host`（`src/mcp-host-server.js`） | 只有 `snowluma_status`（只读探活） | 不启动、不停止网关 |
| `web-search-safe`（`src/mcp-web-search-safe.js`） | `web_search` / `web_fetch` | SSRF 防护、正文大小上限 |

桥接还会**检测发送类工具调用**：这一轮 agent 已经自己发过消息，就不再重复转发它的文本。

`closed-agent` 模式反过来——只在 owner 私聊里挂完整工具集，可以在 QQ 上遥控 DSH 干活。

## 6. DSH 协议适配

桥接不依赖 DSH 的私有 SDK 版本，而是直接说它的 HTTP/WS 协议（`src/dsh-client.js`）：

| 环节 | 做法 |
| --- | --- |
| 鉴权 | 用 `~/.dsh` 里持久化的浏览器会话签名密钥**离线铸造 Cookie**；DSH ≥ 0.1.7 的进程启动 token 只在内存里，读日志那条路已失效 |
| RPC | `POST /api/<namespace>/<method>`（斜杠形式），如 `session/prompt`、`session/selectModel` |
| 事件 | `/api/remote.mux` 事件流 + `session/follow`，按会话过滤 |
| 待处理队列 | 一元 `session/projections` 为主路径，`projections[<id>].values.inbox` 为回退形状 |
| 审批 / 提问 | 桥接拦截审批与 `ask_user_question`，转发到 QQ，回复即决策 |

> 协议代次是**硬边界**：DSH `0.1.2-alpha.1` 起才有点号→斜杠的这次切换。更早的 DSH 请用上游对应的 tag。

## 7. 媒体管线

- 下载统一走 `src/safe-fetch.js`：只允许公网地址，拦内网/私有段/回环，DNS 多地址**逐个校验 + 故障切换**，IPv4 优先（修过一次「DNS 先给 IPv6、本机没出口、每条白等 20 秒」）
- 归一化 `src/media-normalize.js`：单条消息总量、单张像素、张数上限；动图取帧拼成网格；喂模型的体积另有一档上限
- 表情包优先级：QQ CDN 直链 → `emoji_id` 推 CDN 兜底 → 占位文本

## 8. 状态与落盘

`state/` 全部不入库（`.gitignore`），README 里说的「重启不丢」指的就是这些：

| 文件 | 内容 |
| --- | --- |
| `sessions.json` | QQ 会话 ↔ DSH 会话映射 |
| `social-v2.json` | 二代仿真运行时：未读水位、唤醒配置、最近消息、观察状态 |
| `initial-prompts.json` | 每个会话的「初始提示词」（首次唤醒注入一次） |
| `slang.json` | 黑话词库（候选 / 已确认 / 解释） |
| `stickers.json` | 表情包知识库（备注、用途、使用次数） |
| `token-usage.jsonl` | 逐轮 token 明细（成本看板的数据源） |
| `tool-calls.jsonl` | 工具调用日志 |
| `session-titles.json` | 会话标题表（只读，可由 `config.sessionTitleFile` 指到别处） |
| `learning/` | 学习本：`global.md` + `学习本/group-<id>.md` |
| `situation.md` | 处境摘要（只读注入，取第一个含【…】的段，上限 300 字） |
| `bridge.log` / `guardian.log` | 运行日志 |
| `console-token` | 控制台令牌（首次启动生成） |

## 9. 安全边界（摘要）

| 边界 | 机制 |
| --- | --- |
| 谁能触发 | 白名单 + 黑名单，默认 fail-closed；空配置不是「全放行」 |
| 能调什么工具 | 每个模式一套工具面；QQ 会话只有安全子集 |
| 能发到哪 | 发送工具强制校验目标在 `allow` 里 |
| 能读写哪些文件 | 学习本/语音库路径限制在仓库内，拒绝 `..` 与绝对路径 |
| 出站网络 | 只允许公网，拦私有段与重绑定；DNS 逐地址校验 |
| 落盘机密 | `config.json` / `state/` 不入库；`privacy-scan` 提交前拦截 |
| 控制台 | 令牌鉴权，默认回环地址 |

完整威胁模型、已知残余风险、发布前回归清单见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)。

## 10. 代码地图

| 文件 | 职责 |
| --- | --- |
| `src/bridge.js` | 主程序：准入、会话、拆条、唤醒调度、控制台路由（单文件很大，是已知技术债） |
| `src/dsh-client.js` | DSH 协议客户端：Cookie 铸造、斜杠 RPC、mux 事件流、turn collector |
| `src/core/session-router.mjs` | 会话 key 规范化与路由、模式迁移、初始会话状态 |
| `src/mcp-snowluma-safe.js` | QQ 动作安全子集的 MCP server |
| `src/mcp-host-server.js` / `src/mcp-web-search-safe.js` | 只读探活 / 搜索抓取 |
| `src/safe-fetch.js` | SSRF 防护传输 |
| `src/media-normalize.js` | 图片归一化（含动图） |
| `src/role-card.js` | 人格卡按模式筛选小节、字数统计 |
| `src/preset-prompt.js` | 仿真层提示词的读写（`dsh/agent-presets/*`） |
| `src/token-ledger.js` | 用量折叠与峰谷计价 |
| `src/chat-model.js` | 线路模型解析（`followBot` > `dsh.*` > 默认） |
| `src/v2-wait.js` | 「对方说完了吗」的判断 |
| `src/console/routes/*` | 控制台 API 路由（逐步从 bridge.js 拆出） |
| `public/console.html` | 控制台前端（单页，无构建步骤） |

## 11. 已知技术债

- `src/bridge.js` 超过一万行，控制台路由与业务逻辑混在一起（`src/console/` 是拆分进行中）
- 部分回归套件与重构后的行为不一致，见 [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md)
- 没有端到端测试环境（真 QQ 账号 + 真网关），`scripts/test-*` 全部是离线夹具
