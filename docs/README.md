# 文档索引

> 根目录只放 `README.md` / `README.en.md` / `RULES.md` / `CHANGELOG.md` / `KNOWN_ISSUES.md`，其余都在这里。
> 状态标记：✅ 仍然有效 · ⚠️ 部分过时 · 🗄️ 已被取代

## 先读这几篇

| 文档 | 一句话 | 状态 |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **整体架构**：三层职责、消息旅程、会话模型、唤醒调度、工具面、DSH 协议、状态文件、代码地图 | ✅ |
| [PERSONA.md](PERSONA.md) | **写人设**：两层提示词怎么分、人格卡结构、注入上限、学习本与处境摘要、反模式清单 | ✅ |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录结构与 `scripts/` 命名约定 | ✅ |

## guides/ —— 面向使用者与运维

| 文档 | 一句话 | 状态 |
| --- | --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | DSH 端安装：两个 preset 与三个 MCP server 怎么挂上去 | ✅ |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | **安全基线与威胁模型**：准入、工具面、出站、落盘、控制台、已知残余风险、发布前回归清单 | ✅ 改安全代码前必读 |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 脱敏规则与 `privacy-scan` 的用法 | ✅ |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 「令牌与花费」看板：数据来源、峰谷计价、API | ✅ |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览与浏览器回归怎么跑 | ✅ |
| [guides/DSH_021_ADAPTATION.md](guides/DSH_021_ADAPTATION.md) | 适配 DSH 0.2.1 的改动记录（升级 DSH 前先看增量清单） | ✅ 最新 |
| [guides/DSH_020_ADAPTATION.md](guides/DSH_020_ADAPTATION.md) | 适配 DSH 0.2.0 的改动记录（逐条现象/证据/验证） | ✅ |

## 仓库根目录

| 文档 | 一句话 |
| --- | --- |
| [../README.md](../README.md) | 中文落地页：是什么、为什么不一样、快速开始 |
| [../README.en.md](../README.en.md) | 英文落地页 |
| [../RULES.md](../RULES.md) | QQ 会话的权限边界与安全承诺（**用之前必读**） |
| [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md) | 已知问题与暂时红的回归套件 |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本记录 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 开发、提交、隐私规则 |
| [../SECURITY.md](../SECURITY.md) | 漏洞怎么报 |

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 搞懂整体架构 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 在新设备上装起来 | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 写一个人设 | [PERSONA.md](PERSONA.md) |
| 改安全相关代码前 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) |
| 看 AI 烧了多少钱 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 提交前自查泄漏 | [guides/PRIVACY.md](guides/PRIVACY.md) |
| 知道某个目录是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
