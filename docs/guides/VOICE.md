# 语音

> 一句话：**收**到的语音只显示占位文本；**发**语音是支持的，但**默认是关的**。

## 1. 发语音的三条通道

| 通道 | 入口 | 给谁用 |
| --- | --- | --- |
| 命令行 | `node scripts/send-voice.mjs` | 你自己/脚本 |
| AI 工具 | MCP 工具 `send_voice`（`socialV2.voice.enabled` 与 `tools.sendVoice` 两个开关都开） | 群友模式下的 agent |
| 控制台 | 「调试与运维」页的语音操作 | 你自己 |

图形界面与交互式 CLI 在**仓库之外的独立工具** `voice-tool/` 里（`voice-gui.mjs` / `voice-cli.mjs`，
启动器是上一级的 `发语音-图形界面.cmd`）。它不依赖桥接运行，共享内核仍是本仓库的 `src/voice-core.js`——
单一实现，两边一起改。

```bash
# 仓库内：命令行发一条
node scripts/send-voice.mjs --help

# 仓库外（把 voice-tool/ 放在仓库同级）：
cd ../voice-tool
node voice-cli.mjs status     # 账号/token 自动发现 + 连通性
node voice-cli.mjs list       # 可发的群聊/私聊 + 语音库
node voice-gui.mjs            # 图形界面（本地小服务 + 浏览器 UI）
```

## 2. 为什么默认关闭

1. **音色/内容不可控**：模型生成的文本一旦变成语音，语气、停顿、口音都不再受人格卡约束；
2. **成本与延迟**：合成 + 上传比发文字慢一个数量级；
3. **平台风险**：语音消息更容易被判定为异常行为。

要用就在控制台显式打开：

```json
"socialV2": {
  "voice": {
    "enabled": true,
    "dir": "audio",
    "maxSeconds": 30,
    "maxBytes": 2097152,
    "maxPerMinute": 2,
    "maxPerHour": 10
  }
}
```

`tools.sendVoice` 也要一起打开——`enabled` 管「这个能力在不在」，`tools.sendVoice` 管「模型能不能调」。

## 3. 音频从哪来

- 把音频文件放进 `audio/`（默认目录，`socialV2.voice.dir` 可改；**相对路径**，别写死本机绝对路径）
- 支持常见格式；`ffmpeg` 用于转码与响度归一化（`socialV2.voice.ffmpegPath` 可指定）
- 单条上限：时长 `maxSeconds`、体积 `maxBytes`；超了直接拒绝，不会偷偷截断

## 4. 安全边界

- AI 通道只能发**自己那个会话**的语音；操作者通道（CLI/控制台）凭 `consoleToken`
- 路径限制在语音库目录内，拒绝 `..` 与任意外部绝对路径
- 指标：`maxPerMinute` / `maxPerHour` 双桶限流，防止刷屏
- 文件体积与时长在**上传前**校验，避免把大文件塞进网关

## 5. 排错

| 现象 | 原因 |
| --- | --- |
| AI 一直不发语音 | `socialV2.voice.enabled` 或 `tools.sendVoice` 没开 |
| `401` / 找不到账号 | `voice-tool/` 里的 `config.json` 与桥接的不是同一份，或 SnowLuma 换了账号（token 会变） |
| 发出去是文件不是语音条 | 音频格式/时长不被网关接受，转码后用 `maxSeconds` 内的片段重试 |
| 收到语音只显示 `[语音]` | 预期行为：**收**语音不做转写 |
