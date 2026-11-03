// 线路解析：决定 QQ 助手这一轮用哪条 provider/model。
//
// 来源优先级：
//   1) dsh.followBot —— 从 ~/.dsh/bot/state.json 读那个 Bot 当前的 model，
//      实现「在 DSH GUI 里改一次 Bot 的模型，QQ 助手跟着走」。
//   2) dsh.provider / dsh.model —— config.json 里的显式兜底。
//   3) 函数内置默认（deepseek-official/deepseek-flash）。
//
// 抽成独立模块是为了能脱离桥接进程做单测：见 tools/chat-model-check.mjs。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 把 "provider/model" 拆成两段。provider 不含斜杠，model 可以带斜杠（如 magpie/auto/xxx）。 */
export function parseModelRef(ref) {
  const s = String(ref ?? '').trim();
  const slash = s.indexOf('/');
  if (slash <= 0 || slash === s.length - 1) return null;
  return { provider: s.slice(0, slash), model: s.slice(slash + 1) };
}

export function resolveDshHome(explicit) {
  const fromArg = explicit === undefined || explicit === null ? '' : String(explicit).trim();
  if (fromArg) return fromArg;
  const fromEnv = process.env.DSH_HOME ? String(process.env.DSH_HOME).trim() : '';
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/** 读 bot 注册表里某个 Bot 的 model。返回 { ref, effort } 或 { error }。
 *  `~/.dsh/bot/state.json` 有 400~500KB，而桥接现在每条消息都要解析一次线路
 *  （followBot 变了要立刻跟着切，见 bridge.js 的 ensureChatModel），所以按
 *  「followBot + dshHome」缓存 3 秒：够快到用户改完模型下一条消息就生效，
 *  又不至于每条消息都读盘。一次性脚本（chat-model-check）每次都是新进程，不受影响。
 */
const BOT_CACHE_TTL_MS = 3000;
let botCache = { at: 0, key: '', result: null };

export function readBotModelSelection({ followBot, dshHome, fresh = false } = {}) {
  const name = String(followBot ?? '').trim();
  if (!name) return { error: 'followBot 未配置' };
  const cacheKey = `${name}\u0000${String(dshHome ?? '')}`;
  const now = Date.now();
  if (!fresh && botCache.result && botCache.key === cacheKey && now - botCache.at < BOT_CACHE_TTL_MS) {
    return botCache.result;
  }
  const result = readBotModelSelectionUncached(name, dshHome);
  botCache = { at: now, key: cacheKey, result };
  return result;
}

function readBotModelSelectionUncached(name, dshHome) {
  const file = path.join(resolveDshHome(dshHome), 'bot', 'state.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: `读 ${file} 失败：${error?.message ?? error}` };
  }
  const bots = raw?.bots;
  const list = Array.isArray(bots) ? bots : (bots && typeof bots === 'object' ? Object.values(bots) : []);
  const hit = list.find((b) => b && String(b.name ?? b.displayName ?? '').trim() === name);
  if (!hit) return { error: `没有名为「${name}」的 Bot` };
  const ref = String(hit.model ?? '').trim();
  if (!parseModelRef(ref)) return { error: `Bot「${name}」的 model 不可用（${ref || '空'}）` };
  return { ref, effort: hit.effort ?? hit.reasoningEffort ?? null };
}

/**
 * 解析本轮要用的线路。
 * effort 默认归桥接管（dsh.reasoningEffort）：QQ 对话的节奏/延迟直接由它决定，
 * 跟 Bot 上那个 effort 不是一回事（Bot 的 effort 只作用于它自己的 DSH 会话）。
 * 要让 QQ 跟着 Bot 的 effort 走，把 dsh.followBotEffort 设成 true。
 * @returns {{provider, model, effort, effortSource, source, botEffort, warning?}}
 */
export function resolveChatSelection({ followBot, provider, model, effort, followBotEffort, dshHome } = {}) {
  const bridgeEffort = String(effort || 'low');
  const bot = readBotModelSelection({ followBot, dshHome });
  if (bot.ref) {
    const parsed = parseModelRef(bot.ref);
    const useBotEffort = followBotEffort === true && bot.effort !== null && bot.effort !== undefined && String(bot.effort).trim() !== '';
    return {
      provider: parsed.provider,
      model: parsed.model,
      effort: useBotEffort ? String(bot.effort).trim() : bridgeEffort,
      effortSource: useBotEffort ? 'bot' : 'bridge',
      source: `followBot:${String(followBot).trim()}`,
      botEffort: bot.effort,
    };
  }
  return {
    provider: String(provider || 'deepseek-official'),
    model: String(model || 'deepseek-flash'),
    effort: bridgeEffort,
    effortSource: 'bridge',
    source: 'config',
    botEffort: null,
    // followBot 配了却读不到时不要静默切回官方线：把原因带回调用方写日志。
    warning: String(followBot ?? '').trim()
      ? `⚠️ followBot「${String(followBot).trim()}」不可用（${bot.error}），回退到 dsh.provider/model 配置值`
      : undefined,
  };
}
