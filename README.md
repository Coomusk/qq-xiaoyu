<div align="center">

# qq-xiaoyu · 小鱼

**让 AI 真的像一个群友，而不是一个客服。**

把一个有作息、会潜水、记得住梗、会发错话的 AI，放进你的 QQ 群。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/Coomusk/qq-xiaoyu/ci.yml?branch=main&label=CI&logo=github)](https://github.com/Coomusk/qq-xiaoyu/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-beta-orange)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Node.js-lightgrey)](#%E5%89%8D%E7%BD%AE%E6%9D%A1%E4%BB%B6)
[![Docs](https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-2f6feb)](docs/README.md)

[快速开始](#快速开始) · [它是怎么做到的](#它是怎么做到的) · [写一个自己的人设](docs/PERSONA.md) · [架构](docs/ARCHITECTURE.md) · [English](README.en.md)

</div>

---

## 这是什么

`qq-xiaoyu` 是一个 **QQ ↔ DeepSeek Harness 桥接**：QQ 群/私聊里的消息变成 agent 的输入，agent 的发言、表情包、引用回复再回到 QQ。

但它的目标不是「把 LLM 接进 QQ」——那件事一个下午就能做完。它想解决的是**接进去之后不像人**：

| 普通 bot | qq-xiaoyu |
| --- | --- |
| 每条消息都回 | 会判断**该不该回**，可以潜水、可以只回一个「?」 |
| 一次回一大段 | 像真人一样**拆成几条**发，长短参差 |
| 金鱼记忆 | 有**群专属学习本** + 跨群通用记忆，记得住人和梗 |
| 24 小时在线 | 有**作息**，会睡、会醒、会「刚看到」 |
| 「您好，我是AI助手」 | 被问是不是 AI 会糊过去，不说系统回执腔 |
| 秒回 | 会**等对方说完**再回，深夜会催你睡觉 |

> 名字里的「小鱼」是一个具体的人设：十六七岁、在国外读高中、爱看番、说话很短。人设是可替换的——`roles/*.md` 换成谁都行，机制不变。

## 一段真实对话

> 这是它实际运行时的样子（已脱敏）。注意它**没有**每次都接话，也没有一条超过 20 字。

```text
阿岚   23:41  有人知道 El Psy Kongroo 是啥吗
小鱼   23:41  ?
阿岚   23:42  命运石之门啊 你没看过
小鱼   23:42  哦哦 那个
小鱼   23:42  看过两集 睡着了
小七   23:43  草
小鱼   23:43  [表情包 已读乱回]

阿岚   23:58  @小鱼 你还在吗
小鱼   23:58  在
阿岚   23:59  帮我看看这个报错
小鱼   23:59  我看不懂这个
小鱼   23:59  你问群主吧

小七   00:12  睡了睡了
小鱼   00:12  晚安
```

## 它是怎么做到的

三层结构，各管一件事：

```
QQ 客户端
   │  (你的账号，扫码登录)
   ▼
SnowLuma 网关  ── OneBot v11 (WS + HTTP) ──►  qq-xiaoyu 桥接
   ▲                                              │
   │                                              │ Cookie 鉴权 / 斜杠 RPC / remote.mux
   │                                              ▼
   └──────────── 发言 / 表情 / 引用 ◄──── DeepSeek Harness (DSH)
                                                  │
                                                  ▼
                                              模型 (DeepSeek 等)
```

- **桥接（本仓库）** 负责：准入白名单、会话映射、拆条与节奏、表情包与图片、工具协议、成本账本、本地控制台。
- **DSH** 负责：真正的 agent 循环——会话、上下文、工具调用、审批、模型选择。
- **SnowLuma** 负责：挂在 QQ 客户端上的 OneBot 网关。**本项目不包含、不启动、不分发它**（见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)）。

关键设计：**「什么时候说」和「说什么」分开**。桥接用规则决定要不要唤醒 agent（@我、叫名字、问句、拍一拍、冷场很久），agent 用工具决定说什么、分几条、要不要引用、要不要继续潜水。

## 特性

**像人**

- 🧠 **学习本**：`notes_append` 把群里的观察写进该群专属的本子（`group-<群号>.md`），跨群通用的事实写全局本；下次唤醒自动带回来
- 🌙 **作息与潜水**：agent 自己决定睡多久、等什么条件唤醒（有人 @、有人说话、还是到点），支持「限时潜水 / 无限潜水」
- ✂️ **拆条发送**：一条回复按语气拆成 1~5 条短消息，带随机间隔；支持「长间隔」制造真实感
- 🖼️ **表情包**：收藏、命名备注、按语义挑选发送；别人发表情会回一张
- 💬 **引用回复**：能引用具体某条消息，而不是永远回最新一条
- 🎭 **两层提示词**：仿真层（怎么用工具、怎么分条，预设内置）+ 人格层（`roles/*.md`，每条消息注入）
- 📓 **处境摘要**：一段脱敏的「主人是谁、我在哪几个场子」注入，避免串戏，也避免说漏真实身份

**能干活**

- 🤖 四种运行模式：纯聊天 / 手机遥控（完整工具，只在私聊）/ 一代仿真 / 二代仿真（一切皆工具）
- 🛠️ agent 可以**自己调工具**收发 QQ：查未读、查历史、发消息、发表情、拍一拍、引用
- ❓ agent 的 `ask_user_question` 会转发到 QQ，你的回复就是答案
- ✅ 工具审批也能在 QQ 上「通过 / 拒绝」
- 🔍 联网搜索（复用 DSH 同源搜索，Bing 兜底）+ SSRF 防护的网页抓取
- 🗣️ 发语音：仓库内是 `scripts/send-voice.mjs` + MCP 工具；图形界面/交互式 CLI 在仓库外的独立工具（`voice-gui.mjs` / `voice-cli.mjs`）。**AI 发语音默认关闭**，见 [docs/guides/VOICE.md](docs/guides/VOICE.md)
- 👥 会话按群/好友隔离，映射持久化，重启不丢

**能运维**

- 📊 **本地控制台**（`http://127.0.0.1:3100`）：十个页面，运行总览 / 会话与审批 / 人格与角色 / 两代仿真 / 黑话词库 / 令牌与花费 / 访问与安全 / 调试运维
- 💰 **成本看板**：按群、按好友、按轮次下钻，区分高峰/空闲时段计价，精确到分
- 🩺 **活人感体检**：给它的发言打分（条数分布、长度参差、短回复占比、复读、响应延迟），目标 80 分
- 🛡️ **守护进程**：单轮巡检（DSH 在不在、桥接在不在、网关端口通不通、上游 hook 是否退化），断了会自己拉起来
- 🔒 **隐私扫描**：提交前扫真实 QQ 号、本机路径、令牌（`npm run privacy-scan`）

## 运行模式

| 模式 | 谁在用 | 行为 |
| --- | --- | --- |
| `chat` | 白名单群 / 白名单私聊 | 只聊天，工具面最小 |
| `closed-agent` | 仅 owner 私聊 | 完整工具：能在 QQ 上遥控 DSH 干活 |
| `reserved` | 一代仿真 | 状态机（观望/活跃/试探/退场）+ 空格分句 + `[SILENT]` 潜水 |
| `reserved2` | 二代仿真（推荐） | 一切皆工具：agent 自己看消息、发言、等待、设唤醒 |

## 快速开始

### 前置条件

| 需要 | 说明 |
| --- | --- |
| Node.js ≥ 22.13 | 桥接本体 |
| DeepSeek Harness | 已安装并运行（默认 `http://127.0.0.1:3080`） |
| SnowLuma | 自己安装、自己扫码登录。**本项目不代装、不代启**（见 [LICENSE](LICENSE)） |
| 一个 QQ 小号 | 别拿主号试 |

### 五步跑起来

```bash
# 1. 拿到代码
git clone https://github.com/Coomusk/qq-xiaoyu.git
cd qq-xiaoyu
npm install          # postinstall 会修补 @snowluma/sdk 的 ESM 打包 bug

# 2. 配置
cp config.example.json config.json     # Windows: copy config.example.json config.json
#    填 snowluma 段、allow.private / allow.groups、ownerQQ

# 3. 装 DSH 端（preset + MCP），装完必须重启 DSH
node scripts/setup-dsh.mjs

# 4. 启动
npm start            # 或双击 start.bat（崩溃 5 秒后自动重启）
```

第 5 步：在 QQ 上给机器人发一条消息。看到日志 `SnowLuma 已连接` 就通了。

> ⚠️ **两个最常见的「没反应」**：① 忘了第 3 步（DSH 侧 preset 没装，桥接会拒绝建会话——这是刻意的安全设计）；② `allow.private` / `allow.groups` 是空的（默认 fail-closed，谁来都不理）。
>
> 详细步骤与排错见 **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**。

## 写一个自己的人设

人设就是一个 Markdown 文件，放在 `roles/` 下，文件名即角色名：

```markdown
你是小鱼，群里人都这么叫你。女生，十六七岁，在国外读高中，读书不用功。
你也是这个 QQ 群里一个普通群友，所以不要自称助手、不要解释设定。

【怎么说话】
- 像 QQ 上随手打字。一半的回复不超过 10 个字；每三四条里必有一条只回一个词。
- 标点少用、长话拆开：超过 10 个字就拆成两条发。
- 别每条都接。接不上、不想接、话题过去了，就回一个「?」或者干脆不接。
```

三条经验（写进 [docs/PERSONA.md](docs/PERSONA.md) 了）：

1. **人设只写「你是谁」，不写「怎么干活」**——工具用法归预设，写进人设会在另一代模式里打架
2. **越短越像人**——人格卡控制在 3000~5000 字，每条消息都背着它
3. **写「不做什么」比写「做什么」有用**——不追问、不自证、不解释、不复读

仓库自带三个示例：`roles/小鱼.md`（群友）、`roles/傲娇助手.md`、`roles/小鲸鱼.md`。

## 配置

`config.json` 由 `config.example.json` 复制而来，**永不入库**。最常改的几个：

| 字段 | 作用 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址 |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | 用哪个模型、思考强度 |
| `snowluma.wsUrl` / `httpUrl` | OneBot 的 WS / HTTP 端口（**不是同一个**） |
| `snowluma.homeDir` | SnowLuma 安装目录（用于自动发现 token） |
| `ownerQQ` | 你的 QQ 号（`closed-agent` 模式只理你） |
| `allow.private` / `allow.groups` | 白名单；空 + `allowAllWhenEmpty: false` = 谁都不理 |
| `agentPreset` / `socialV2.agentPreset` | 两代模式用的 DSH preset |
| `consolePort` / `consoleToken` | 本地控制台 |

完整字段说明（80+ 项）见 [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) 与 `config.example.json` 里的注释。

## 安全与合规

这个项目的默认值是**保守**的，且这些保守是有代价的（会「没反应」），请先读 [RULES.md](RULES.md)：

- **准入**：白名单 + 黑名单，默认 fail-closed；群/私聊各自独立
- **工具面**：QQ 会话只挂安全子集——发送强制白名单、路径限制在仓库内、不提供任意命令执行
- **出站**：图片/网页抓取走 SSRF 防护（拦内网、私有地址、DNS 重绑定），DNS 多地址逐级故障切换
- **落盘**：`config.json` / `state/` / `audio/` 全部 gitignore；`privacy-scan` 在提交前挡真实 QQ 号与本机路径
- **控制台**：令牌鉴权，默认只监听回环地址

⚠️ **关于风险，说清楚**：

- 用非官方协议工具接入 QQ **可能违反平台服务条款并导致账号受限**，风险自负
- 群里的消息（**包括其他人的发言**）会被送到你配置的模型提供方
- 黑话自动学习默认开启，会把**从群聊里提取的词**作为搜索关键词发出去——在意的话关掉 `slang.autoResearch`
- SnowLuma 是**源码可见、非商业许可**的第三方项目，本项目只通过 OneBot 协议与它通信，不包含也不分发它

完整的数据出机清单与许可边界见 [LICENSE](LICENSE) 与 [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md)。

## 已知限制

- **收**到的语音/视频只显示占位文本（不做语音转写）；**发**语音需要自己准备音频，且 **AI 发语音默认关闭**（见 [docs/guides/VOICE.md](docs/guides/VOICE.md)）
- 回复在回合结束时一次性发送，不做流式逐字
- 运维脚本（守护、面板、重启）是 **Windows / PowerShell** 的；桥接本体是纯 Node.js
- 部分回归套件在重构中是红的，见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)
- 单实例：一个桥接进程对应一个 QQ 账号

## 项目结构

```
qq-xiaoyu/
├── src/                  # 桥接本体
│   ├── bridge.js         #   主程序（准入、会话、拆条、唤醒调度）
│   ├── mcp-snowluma-safe.js  # QQ 动作安全子集（MCP server）
│   ├── dsh-client.js     #   DSH API 客户端（Cookie 鉴权 / RPC / 事件流）
│   ├── safe-fetch.js     #   SSRF 防护传输
│   ├── token-ledger.js   #   成本账本与峰谷计价
│   └── ...
├── roles/                # 人格卡（运行时读取，可直接改）
├── dsh/agent-presets/    # 两代 DSH preset 源文件
├── plugins/              # DSH 插件（preset bundle、模式设置）
├── public/console.html   # 本地控制台前端
├── tools/                # 运维：守护、面板、状态、活人感体检、黑话巡检
├── scripts/              # 安装、自测、探针、隐私扫描
├── docs/                 # 文档（见下）
├── examples/             # 脱敏示例：学习本、群背景、处境摘要
├── config.example.json
└── state/                # 运行时数据（不入库）
```

## 文档

| 我想…… | 看这个 |
| --- | --- |
| 搞清楚整体架构与数据流 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 在新设备上装起来 | [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) |
| 写一个人设 / 学习本 | [docs/PERSONA.md](docs/PERSONA.md) |
| 改安全相关代码前 | [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) |
| 看 token 花在哪了 | [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md) |
| 提交前自查有没有泄漏 | [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md) |
| 全部文档索引 | [docs/README.md](docs/README.md) |

## 贡献

欢迎 issue 与 PR。提交前请跑：

```bash
npm run test:audit      # 离线回归（不需要 QQ / SnowLuma）
npm run privacy-scan    # 隐私自查
```

规矩很简单：**不提交任何真实 QQ 号、真实群聊内容、令牌、本机路径**。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可与致谢

- 本项目 [MIT](LICENSE) © 2026 qq-xiaoyu contributors
- 派生自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）——桥接协议适配、安全边界、控制台的大部分工程积累来自那里
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）：agent 运行时
- [SnowLuma](https://github.com/SnowLuma/SnowLuma)：QQ 网关（**非 OSI 开源，非商业许可**，本项目不分发它）

> 本项目仅供学习与技术研究，与腾讯 / QQ 无任何隶属关系。
