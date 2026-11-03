# 已知问题

> 记录**当前确实不工作**或**测试是红的**的东西。不粉饰：红的就写红。
> 最后核对：2026-11-03（v0.3.0-beta.1）

## 一、红的回归套件（`npm run test:audit` → 33/35）

这 2 个套件仍失败，都是**真实行为断言**，不是环境问题。CI 只跑稳定子集，见 `.github/workflows/ci.yml`。

| 套件 | 失败的断言 | 初步判断 |
| --- | --- | --- |
| `test-token-economy.mjs` | 4 条：观察游标语义（`200 !== 403`、`undefined !== true`）——暂停/换会话/限流后，in-flight 的 wait 仍然授权了观察 | 「观察」与「已读水位」的授权关系在重构后变了。**可能是测试滞后，也可能是权限漏洞，未定性** |
| `test-reply-wait.mjs` | 4 条：首回复在快照已经安静时不应等满 timeout；快照与 wait 之间的新消息不应重复、且未读仍应可见 | `qq_wait_for_messages` 的计时起点与去重逻辑；`getUnread` 投影也报空 |

> **已修的套件**（都属「只有作者机器能过」或「断言写的是旧版文案」）：
> - `test-audit-setup-guards.mjs` —— `start.bat` 有一行中文 `rem`，非 UTF-8 控制台乱码；改成英文注释
> - `test-voice-system.mjs` —— 无条件读被 gitignore 的 `docs/guides/VOICE.md`，全新 clone 直接 ENOENT 崩溃；补文档 + 存在性守卫
> - `test-preset-local-tools.mjs` —— 找不到 DSH 安装时 `dshPackagesDir()` 抛错穿透成失败；归一成「跳过」
> - `test-audit-regressions.mjs`（R4）与 `test-v2-initial-prompt.mjs` —— 根因是**审计脚手架** `scripts/audit-bridge-harness.mjs` 的 VM 上下文漏注入 `src/role-card.js`，`buildWakePromptV2` 里 `selectRoleText is not defined` → 所有唤醒投递都失败。**产品代码本身没坏**（生产里是正常 import）
> - `test-issue-regressions.mjs`（#29）—— 断言写的是旧标签 `【你的身份】`，而唤醒提示已合并成 `【身份】`（省 token）；改为匹配 `【(你的)?身份】`，保留「必须带身份」的本意

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
