# 已知问题

> 记录**当前确实不工作**或**测试是红的**的东西。不粉饰：红的就写红。
> 最后核对：2026-11-03（v0.3.0-beta.1）

## 一、红的回归套件（`npm run test:audit` → 30/35）

这 5 个套件失败，都是**真实行为断言**，不是环境问题。CI 只跑稳定子集，见 `.github/workflows/ci.yml`。

| 套件 | 失败的断言 | 初步判断 |
| --- | --- | --- |
| `test-token-economy.mjs` | 8 条：观察游标语义（`200 !== 403`、`undefined !== true`）——暂停/换会话/限流后，in-flight 的 wait 仍然授权了观察 | 重构后「观察」与「已读水位」的授权关系变了，测试还按旧契约断言。**可能是测试滞后，也可能是权限漏洞，未定性** |
| `test-reply-wait.mjs` | 4 条：首回复在快照已经安静时不应等满 timeout；快照与 wait 之间的新消息不应重复 | 「等对方说完」的计时起点与去重逻辑 |
| `test-audit-regressions.mjs` | R4：到期的**有限潜水**没有补发一次 `timeout` 唤醒（`0 !== 1`） | 唤醒定时器在某种状态下不触发——**这条影响真实体验**（设了潜水到点不醒） |
| `test-issue-regressions.mjs` | #29：唤醒 prompt 里没有机器人自己的昵称与 QQ 号 | 身份注入丢了。agent 靠这段对上「我是谁」，缺了容易把别人的话当成对自己说的 |
| `test-v2-initial-prompt.mjs` | 2 条：`bootstrap` 没有真的投递一次 prompt；首条群消息没有触发恰好一次 bootstrap | 初始提示词在首唤醒时可能发不出去 |

> 曾经还有 2 个套件是红的，已修：
> - `test-audit-setup-guards.mjs` —— `start.bat` 里有一行中文 `rem`，在非 UTF-8 控制台会乱码；已改成英文注释
> - `test-voice-system.mjs` —— 它无条件读 `docs/guides/VOICE.md`，而该文件曾被 gitignore，**全新 clone 直接 ENOENT 崩溃**；已补文档并加存在性守卫

## 二、功能限制（设计如此，不是 bug）

| 限制 | 说明 |
| --- | --- |
| 收到的语音/视频 | 只显示 `[语音]` / `[视频]` 占位，不做转写 |
| 回复不做流式 | 回合结束一次性发送，不逐字转发 |
| 单实例 | 一个桥接进程 = 一个 QQ 账号 |
| 运维脚本 | 守护/面板/重启是 Windows + PowerShell；桥接本体跨平台 |
| 语音工具 | 图形界面与交互式 CLI 在仓库外（`voice-tool/`），不进主仓库 |

## 三、技术债

- `src/bridge.js` 单文件一万二千行，控制台路由与业务逻辑混在一起；`src/console/`、`src/core/` 是拆分进行中的产物
- 没有端到端测试：所有 `test-*` 都是离线夹具，没有真 QQ 账号 + 真网关的回归环境
- 控制台前端是单文件 `public/console.html`（200 KB+），没有构建步骤，改起来靠搜索
- `@snowluma/sdk` 的 npm 包有 ESM 扩展名 bug，靠 `postinstall` 打补丁（上游打包问题，不是我们的）

## 四、怎么帮忙

如果你要修上面任何一条：

1. 先看 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的对应章节
2. 只改一个套件，跑 `node scripts/<套件>.mjs` 确认从红变绿
3. 顺便补一条能钉住这次修复的反面断言（这个仓库的习惯是「修完加回归」）

PR 里请写清楚：**是测试滞后还是代码 bug**，以及判断依据。
