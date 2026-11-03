# 贡献指南

先读 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [RULES.md](RULES.md)——前者讲代码怎么组织，后者讲**哪些事不能做**（权限边界是硬约束，不是建议）。

## 开发环境

```bash
git clone https://github.com/Coomusk/qq-xiaoyu.git
cd qq-xiaoyu
npm install
cp config.example.json config.json     # 只为跑测试的话，保持里面的空白名单就行
```

- Node.js ≥ 22.13（用的是内置 `fetch`、`node:test`、`zstd`）
- 不需要 QQ / SnowLuma / DSH 就能跑绝大部分测试

## 测试

```bash
npm run test:audit        # 主力：35 个审计型套件，离线、用临时目录
node scripts/test-xxx.mjs # 单个套件（改哪个跑哪个）
npm run privacy-scan      # 提交前必须：挡真实 QQ 号/本机路径/令牌
```

当前 `test:audit` 是 **33/35**，2 个红的套件与原因写在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。**不要**为了让套件变绿去删断言——先判断是测试滞后还是代码 bug，在 PR 里说明依据。

新增行为请顺手加一条能钉住它的回归。这个仓库的习惯是「修完加一条反面断言」，比如一次真实故障修完，会加一条「这个字段不存在时必须显式失败，不能静默当成空」。

## 代码风格

- ESM（`"type": "module"`），2 空格缩进，单引号，语句不省分号
- 运行时依赖保持精简：加依赖前先问「Node 内置能不能做」
- 中文注释可以，但**注释解释「为什么」，不解释「是什么」**——「这里必须二次校验，否则路径穿越」比「校验路径」有用
- 桥接核心（`src/`）不引入原生模块、不做进程注入
- Windows 相关脚本放 `tools/`，用 PowerShell；**不要**在 `.bat` 里写非 ASCII（非 UTF-8 控制台会乱码，`start.bat` 有回归钉着这条）

## 提交信息

用 Conventional Commits，一条提交只做一件事：

```
feat(console): 令牌看板支持按小时下钻
fix(bridge): 有限潜水到期后补发 timeout 唤醒
docs(persona): 补「反模式清单」
test(reply-wait): 钉住首回复的计时起点
```

## 隐私红线（最重要）

这个项目在一台真实机器上跑过，工作树里很容易混进真实数据。**提交前必须**：

1. 跑 `npm run privacy-scan`，红了就修，不要加白名单绕过
2. 确认这些**永远不提交**：`config.json`、`state/`、`audio/`、`scripts/privacy-rules.json`、任何 `*.bak-*`
3. 测试夹具里的 QQ 号/群号一律用假值（`123456789`、`100000001`）
4. 文档里的路径用占位符（`C:\path\to\…`），不要贴自己的真实用户名

如果已经推上去了：**改历史**（`git filter-repo` / BFG），并在 PR 里说明。删一个提交不够——fork 和缓存会留着。

## 改这些东西要特别小心

| 改什么 | 为什么 |
| --- | --- |
| `dsh/agent-presets/**` | 改完必须 `node scripts/build-agent-preset-patches.mjs` 重新生成 patch，否则 DSH 用的是旧 bundle |
| `src/mcp-snowluma-safe.js` 的工具面 | 多暴露一个工具就是多一份风险；发送类工具必须过白名单校验 |
| `src/safe-fetch.js` | SSRF 防护；任何「放行内网」的改动都要在 PR 里单独说明理由 |
| `roles/` 里的示例 | 是给用户抄的模板，别塞真实群号/昵称 |
| `.gitignore` | 放宽任何一条都等于把本地数据推向公开仓库 |

## PR 检查单

- [ ] `npm run test:audit` 没有**新增**失败（数量与 [KNOWN_ISSUES.md](KNOWN_ISSUES.md) 一致）
- [ ] `npm run privacy-scan` 通过
- [ ] 新增/修改的行为有回归
- [ ] 改了目录结构就同步 [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)
- [ ] 改了配置项就同步 `config.example.json`（并保留注释）
- [ ] 没有提交 `config.json` / `state/` / `*.bak-*`

## 行为准则

参与本项目即表示同意 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
