# 安全策略

## 支持范围

| 版本 | 状态 |
| --- | --- |
| `0.3.x`（当前 beta） | ✅ 接受报告 |
| 上游 `qq-bridge` ≤ v0.2.1-r1 | ❌ 请报告给 [上游仓库](https://github.com/Derpyu520/qq-bridge) |

## 怎么报

**不要开公开 issue。** 用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)（仓库 Security 页 → Report a vulnerability）。

报告里请包含：

- 影响版本 / 提交号
- 复现步骤（最小化）
- 影响面：能不能越权发言、读到本不该读的文件、把请求发到内网、拿到令牌
- 如果有 PoC，说明它需要什么前置条件（已认证？已连上 DSH？）

## 什么算安全漏洞

| 类别 | 例子 |
| --- | --- |
| 准入绕过 | 不在白名单里的群/私聊能触发 agent；`deny` 被 `allow` 覆盖 |
| 工具面越权 | QQ 会话拿到不该有的工具（文件、终端、subagent）；发送目标绕过白名单 |
| 路径穿越 | 学习本/语音库/附件读写越出仓库根（`..`、绝对路径、符号链接） |
| SSRF | 下载/抓取能打到回环、私有段、链路本地、云元数据（`169.254.169.254`），或 DNS 重绑定绕过 |
| 凭据泄漏 | `config.json` / `state/` 被写进日志、控制台接口、错误信息、公开仓库 |
| 控制台 | 无令牌可访问、令牌可被 CSRF、越权改配置、`/api/send/*` 绕过白名单 |
| 注入 | 消息内容能改变工具调用参数或系统提示词边界（prompt injection 导致越权动作） |
| 依赖 | 上游包供应链问题（`@snowluma/*`、`@modelcontextprotocol/sdk` 等） |

## 什么**不**算

- **QQ 账号被限制/封禁**：使用非官方协议工具的固有风险，见 [LICENSE](LICENSE) 与 [RULES.md](RULES.md)
- **SnowLuma 自身的问题**（原生 hook 挂不上、收不到消息）：报给 [SnowLuma](https://github.com/SnowLuma/SnowLuma)
- 模型说了不该说的话、人设崩了、回答不准：这是提示词工程问题，开普通 issue
- 你在自己机器上把 `config.json` 提交到公开仓库：不是本项目漏洞，但请立刻改历史并轮换令牌

## 本项目的安全姿态

- 默认 **fail-closed**：空白名单 = 谁都不理
- 工具面按模式收敛：QQ 会话只有安全子集，发送强制白名单
- 出站只允许公网，DNS 逐地址校验 + 故障切换
- 机密只落 `config.json` / `state/`，两者都在 `.gitignore` 里；`privacy-scan` 在提交前拦截
- 不引入遥测、不上报任何数据

完整威胁模型与残余风险见 [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)。
