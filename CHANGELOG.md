# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号用 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.3.0-beta.1] — 2026-11-03

第一个以 `qq-xiaoyu` 名义发布的版本。代码基线是上游 `qq-bridge` v0.2.1-r1 **加本地未合并的改进**，
因此标 beta：功能是全的，回归套件有 5 个是红的（见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)）。

### 新增（相对上游 v0.2.1-r1）

- **学习本**：`notes_append` / `notes_read` 两个工具，分「群专属本」与「全局本」，随每次唤醒注入
- **处境摘要**：`state/situation.md` 只读注入，脱敏的「主人是谁、我在哪几个场子」，上限 300 字
- **会话标题表**：`state/session-titles.json`，桥接只读，支持递增序号
- **控制台**：会话与审批、两代仿真、黑话、令牌与花费、访问与安全等页面扩充；`src/console/routes/` 开始拆分
- **守护进程**：单轮巡检版 `tools/guardian.ps1`（DSH/桥接/网关/上游 hook 四路探活 + 冷却重启）
- **活人感体检** `tools/humanize-audit.mjs`、**黑话夜间巡检** `tools/slang-nightly.mjs`
- **见证脚本**：`tools/wake-prompt-report.mjs`（读 DSH 会话记录核唤醒提示）、`tools/mcp-tool-probe.mjs`

### 变更

- 项目更名 `qq-xiaoyu`，README 重写为「AI 群友」落地页，技术细节下沉到 `docs/ARCHITECTURE.md`
- **移除硬编码的本机路径**，改为可配置或按仓库根解析：
  - `config.sessionTitleFile`（默认 `state/session-titles.json`）
  - 学习本默认 `state/learning/`，处境摘要默认 `state/situation.md`
  - 学习本路径沙箱从「仓库上一级」收紧到**仓库根**
  - 运维脚本的 SnowLuma 目录改读 `config.snowluma.homeDir` / `SNOWLUMA_HOME`
  - 重启脚本的 DSH 路径改读 `DSH_APP_PATH` / 常见安装位置
  - VBS 启动器按脚本自身位置推仓库根
- `start.bat` 恢复纯 ASCII（非 UTF-8 控制台会把中文 `rem` 显示成乱码）
- `test-voice-system` 不再因为可选的 `voice-tool/` 缺失而崩溃；补回 `docs/guides/VOICE.md`

### 修复

- `test-audit-setup-guards`：`start.bat` 的 ASCII 断言从红转绿
- `test-voice-system`：全新 clone 上 `docs/guides/VOICE.md` ENOENT 导致整套崩溃
- `test-preset-local-tools`：找不到 DSH 安装时 `dshPackagesDir()` 抛错穿透成失败 —— 任何干净 clone / CI 必红，现在归一成「跳过」
- `.gitattributes`：preset 的 YAML 行尾钉死 CRLF。曾经写过全局 `eol=lf`，导致全新 clone 上 `test-preset-prompt`（断言保持 CRLF 写回）必红，而作者本地看不出来
- CI：跑在 `windows-latest`（运行面就是 Windows），失败时输出 annotation 指明是哪条套件
- Dependabot：只收 minor/patch，`@snowluma/*` 不动（postinstall 会对它的 dist 打补丁）

### 移除

- `_snowluma-catalog.json`：上游动作目录的快照，运行时零引用；按上游许可说明（§3(b)(c) 再分发限制）不进公开仓库

### 未完成

- 5 个回归套件仍为红：`test-token-economy`、`test-reply-wait`、`test-audit-regressions`（R4）、
  `test-issue-regressions`（#29）、`test-v2-initial-prompt`。详见 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)

## 上游历史

本项目的桥接内核、DSH 协议适配、安全边界与控制台的大量工程积累来自
[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）。上游各版本对应的 DSH 版本：

| 上游 tag | 目标 DSH |
| --- | --- |
| v0.2.1-r1 | 0.2.1-rc.2（0.2.0-rc.2 亦兼容） |
| v0.2.0 | 0.2.0-rc.2 |
| v0.1.7 | 0.1.7-rc.2 |
| v0.1.5 | 0.1.5-rc.1 |
| v0.1.0 | ≤ 0.1.1-rc.2 |
