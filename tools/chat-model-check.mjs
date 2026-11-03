// 验证「QQ 助手这一轮用哪条线路」的解析结果，不启动桥接、不发任何消息。
// 用法：node tools/chat-model-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChatSelection, readBotModelSelection } from '../src/chat-model.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const followBot = cfg.dsh?.followBot;
const bot = readBotModelSelection({ followBot });
const resolved = resolveChatSelection({
  followBot,
  followBotEffort: cfg.dsh?.followBotEffort === true,
  provider: cfg.dsh?.provider,
  model: cfg.dsh?.model,
  effort: cfg.dsh?.reasoningEffort,
});

console.log('config.dsh.followBot =', followBot ?? '(未配置)');
console.log('config.dsh.followBotEffort =', cfg.dsh?.followBotEffort === true, '（false = effort 归桥接管）');
console.log('config.dsh.provider/model =', `${cfg.dsh?.provider}/${cfg.dsh?.model}`);
console.log('config.dsh.reasoningEffort =', cfg.dsh?.reasoningEffort);
console.log('Bot 注册表里该 Bot 的模型 =', bot.ref ?? `(读不到：${bot.error})`, '| Bot 侧 effort =', bot.effort ?? '(未设置)');
console.log('解析结果 =', `${resolved.provider}/${resolved.model}`, '| effort =', resolved.effort,
  `(来自 ${resolved.effortSource === 'bot' ? 'Bot' : '桥接配置'})`, '| 来源 =', resolved.source);
if (resolved.warning) console.log('警告 =', resolved.warning);
const ok = resolved.source.startsWith('followBot') && bot.ref && `${resolved.provider}/${resolved.model}` === bot.ref;
console.log(ok ? '✅ followBot 生效：QQ 助手会跟随该 Bot 的模型' : '❌ 未跟随 Bot 模型（见上面的来源/警告）');
process.exit(ok ? 0 : 2);
