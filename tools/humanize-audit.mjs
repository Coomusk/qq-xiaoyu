#!/usr/bin/env node
// humanize-audit.mjs —— 「活人感」体检器
//
// 数据来源（2026-11-02 改）：**桥接自己的记录** state/social-v2.json
//   conversations[<key>].recentMessages 里 isSelf === true 的那些消息。
//
// 为什么不再读 QQ 私聊历史：QQ 重启后本地历史几乎清空，
//   get_friend_msg_history 只回 3 条、正文还是空的 → 体检永远「没有拿到她的消息」。
//   桥接记录这边还自带表情包标注（[表情包:已读乱回]），比 QQ 历史信息更全。
//
// 用法：node tools\humanize-audit.mjs [每个会话最多取多少条=50]
// 输出：人读的报告（分会话打分 + 合并分），最后一行是给面板解析的 [[JSON]]。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// --social <路径> 只为自测：换一份数据文件跑（测空数据/样本不足时不碰真记录）
const socialArg = process.argv.indexOf('--social');
const SOCIAL = socialArg > -1 && process.argv[socialArg + 1]
  ? path.resolve(process.argv[socialArg + 1])
  : path.join(ROOT, 'state', 'social-v2.json');
const TITLES = process.env.QQ_TITLES_FILE
  ? path.resolve(process.env.QQ_TITLES_FILE)
  : path.join(ROOT, 'state', 'session-titles.json');
const LIMIT = Math.max(10, Math.min(200, Number(process.argv[2]) || 50));
const MIN_SAMPLE = 10;   // 少于这么多条她的消息 → 样本不足，不打分

const WEIGHTS = { 条数分布: 25, 长度参差: 15, 短回复占比: 15, 表情使用: 15, 复读控制: 10, 句式多样: 10, 响应延迟: 10 };
const META_PATTERNS = [/我猜的/, /不用夸/, /别是/, /^行吧/, /^确实/, /^话说/, /基本操作/, /我也觉得/, /是这样的/];

// ── 工具 ─────────────────────────────────────────────────────────────────────
function readJsonSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function sessionTitle(key) {
  const t = readJsonSafe(TITLES, null) || {};
  const v = t[key];
  return typeof v === 'string' && v.trim() ? v.trim() : key;
}
function textOf(m) {
  // 桥接记录里 text 已经带上 [图片] / [表情包:xxx] 这类标注，直接用；
  // 但「是不是表情/图」要用字段判断（text 里可能有普通方括号内容）。
  const raw = String(m.text ?? m.plain ?? '').trim();
  const hasMedia = !!m.sticker || /^\[(图片|表情包|表情)\]/.test(raw) || (Array.isArray(m.media) && m.media.length > 0);
  return { text: raw, hasMedia };
}
function pct(n, total) { return total ? Math.round((n / total) * 100) : 0; }

// ── 取数：每个会话她自己发的消息 ──────────────────────────────────────────────
function collect() {
  const store = readJsonSafe(SOCIAL, null);
  const convs = store?.conversations || {};
  const sessions = [];
  for (const [key, conv] of Object.entries(convs)) {
    const recent = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    const all = recent
      .filter((m) => m && typeof m === 'object')
      .map((m) => ({ ...m, t: Number(m.time) || 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(-LIMIT * 2);
    if (!all.length) continue;
    const mine = all.filter((m) => m.isSelf === true);
    if (!mine.length) continue;
    // 按「一次回复」聚合：连续发、间隔 ≤20 秒算同一组
    const turns = [];
    for (const m of mine) {
      const { text, hasMedia } = textOf(m);
      if (!text) continue;
      const last = turns[turns.length - 1];
      if (last && m.t - last.lastTime <= 20000) {
        last.parts.push({ text, hasMedia, time: m.t });
        last.lastTime = m.t;
      } else {
        turns.push({ parts: [{ text, hasMedia, time: m.t }], firstTime: m.t, lastTime: m.t });
      }
    }
    if (!turns.length) continue;
    // 响应延迟：她这条回复前，最近一条「别人」的消息
    const humans = all.filter((m) => m.isSelf !== true && m.t > 0);
    const delays = [];
    for (const turn of turns) {
      let base = 0;
      for (const h of humans) { if (h.t < turn.firstTime) base = h.t; else break; }
      if (!base) continue;
      const gap = turn.firstTime - base;
      if (gap > 0 && gap < 600000) delays.push(gap);
    }
    sessions.push({
      key,
      name: sessionTitle(key),
      turns,
      delays,
      messages: turns.reduce((a, t) => a + t.parts.length, 0),
    });
  }
  // 样本多的排前面
  sessions.sort((a, b) => b.turns.length - a.turns.length);
  return sessions;
}

// ── 打分 ─────────────────────────────────────────────────────────────────────
function scoreSession(s) {
  const turns = s.turns;
  const total = turns.length;
  const counts = turns.map((t) => t.parts.length);
  const dist = {};
  for (const c of counts) dist[c] = (dist[c] || 0) + 1;

  const allTexts = turns.flatMap((t) => t.parts.map((p) => p.text));
  const allParts = turns.flatMap((t) => t.parts);
  // 纯文本口径：算长度/短回复/复读/机械句式时**排除表情和图片**，
  // 否则「[表情包:来呀打我啊挑衅熊猫]」会既拉高平均长度、又让开头都变成「[表」，
  // 2026-11-02 实测就是这样报出「重复开头 [表×6」这种假复读的。
  const textParts = allParts.filter((p) => !p.hasMedia);
  const textTexts = textParts.length ? textParts.map((p) => p.text) : allTexts;
  const lens = textTexts.map((t) => t.length);
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(lens.length, 1);
  const variance = lens.reduce((a, b) => a + (b - avgLen) ** 2, 0) / Math.max(lens.length, 1);
  const std = Math.round(Math.sqrt(variance));

  const shortCount = textTexts.filter((t) => t.length <= 4).length;
  const mediaCount = turns.filter((t) => t.parts.some((p) => p.hasMedia)).length;

  const heads = textTexts.map((t) => t.slice(0, 2)).filter((h) => h.length >= 2);
  const headCount = {};
  for (const h of heads) headCount[h] = (headCount[h] || 0) + 1;
  const repeated = Object.entries(headCount).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);

  const metaHits = textTexts.filter((t) => META_PATTERNS.some((p) => p.test(t))).length;
  const avgDelay = s.delays.length ? Math.round(s.delays.reduce((a, b) => a + b, 0) / s.delays.length) : 0;

  const S = {};
  const d1 = pct(dist[1] || 0, total);
  const d2 = pct(dist[2] || 0, total);
  S.条数分布 = Math.max(0, 100 - Math.abs(d2 - 35) * 2.2);
  S.长度参差 = Math.min(100, (std / Math.max(avgLen, 1)) * 250);
  S.短回复占比 = Math.max(0, 100 - Math.abs(pct(shortCount, textTexts.length) - 20) * 4);
  S.表情使用 = Math.min(100, pct(mediaCount, total) * 5);
  S.复读控制 = Math.max(0, 100 - repeated.reduce((a, [, n]) => a + (n - 2) * 15, 0));
  S.句式多样 = Math.max(0, 100 - pct(metaHits, textTexts.length) * 2.5);
  S.响应延迟 = delayedScore(avgDelay);

  const dims = {};
  let totalScore = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    dims[k] = Math.round(S[k] || 0);
    totalScore += (S[k] || 0) * (w / 100);
  }

  return {
    key: s.key,
    name: s.name,
    samples: total,
    messages: s.messages,
    textCount: textTexts.length,
    insufficient: allTexts.length < MIN_SAMPLE,
    total: Math.round(totalScore),
    level: totalScore >= 80 ? '像活人' : totalScore >= 60 ? '还行，仍能看出 AI' : '明显机械',
    dims,
    dist1: d1, dist2: d2,
    dist3: pct(dist[3] || 0, total),
    dist4: pct(counts.filter((c) => c >= 4).length, total),
    avgLen: Number(avgLen.toFixed(1)),
    std,
    cv: Number((std / Math.max(avgLen, 1)).toFixed(2)),
    short: pct(shortCount, textTexts.length),
    media: pct(mediaCount, total),
    repeat: repeated.length ? repeated.map(([h, n]) => `「${h}」×${n}`).join(' ') : '无',
    meta: pct(metaHits, textTexts.length),
    delay: Number((avgDelay / 1000).toFixed(1)),
  };
}

function delayedScore(ms) {
  if (!ms || ms < 0) return 50;
  const s = ms / 1000;
  if (s < 2) return 40;
  if (s < 5) return 85;
  if (s < 15) return 100;
  if (s < 60) return 80;
  return 60;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const sessions = collect();
const reports = sessions.map(scoreSession);

if (!reports.length) {
  console.log('桥接记录里没有她的消息（可能是新会话或刚重启），等她聊几句再试。');
  process.exit(1);
}

console.log('══════ 活人感体检报告 ══════');
console.log(`数据来源：桥接记录（state/social-v2.json，取她自己发的消息）`);
const scored = reports.filter((r) => !r.insufficient);
console.log(`样本：${reports.length} 个会话，合计 ${reports.reduce((a, r) => a + r.samples, 0)} 次回复 / ${reports.reduce((a, r) => a + r.messages, 0)} 条消息`);
if (scored.length < reports.length) {
  console.log(`其中 ${reports.length - scored.length} 个会话样本不足（<${MIN_SAMPLE} 条消息），仅供参考、不打分`);
}
console.log('');

for (const r of reports) {
  console.log(`──── ${r.name}（${r.key}）────`);
  console.log(`样本：她的 ${r.samples} 次回复，共 ${r.messages} 条消息`);
  if (r.insufficient) {
    console.log(`样本不足（只有 ${r.messages} 条消息 / ${r.samples} 次回复 < ${MIN_SAMPLE} 条），仅供参考，不打分。`);
    console.log('');
    continue;
  }
  console.log('【原始指标】');
  console.log(`  条数分布: 1条 ${r.dist1}% / 2条 ${r.dist2}% / 3条 ${r.dist3}% / 4+条 ${r.dist4}%`);
  console.log(`  平均长度 ${r.avgLen} 字，标准差 ${r.std}（变异系数 ${r.cv}）`);
  console.log(`  ≤4 字的短回复占 ${r.short}%`);
  console.log(`  带表情/图片的回复占 ${r.media}%`);
  console.log(`  重复开头: ${r.repeat}`);
  console.log(`  机械句式命中 ${r.meta}%`);
  console.log(`  平均响应延迟 ${r.delay} 秒`);
  console.log('【分项得分】');
  for (const [k, w] of Object.entries(WEIGHTS)) {
    const v = r.dims[k] ?? 0;
    const bar = '█'.repeat(Math.round(v / 10)) + '░'.repeat(10 - Math.round(v / 10));
    console.log(`  ${k.padEnd(6)} ${bar} ${String(v).padStart(3)} /100  (权重${w}%)`);
  }
  console.log(`【总分】${r.total} / 100   ${r.level}`);
  console.log('');
}

// ── 合并分：按样本数加权（样本不足的会话不计入）───────────────────────────────
const combinedBase = scored.length ? scored : reports;
const sumSamples = combinedBase.reduce((a, r) => a + r.samples, 0) || 1;
const mergedDims = {};
for (const k of Object.keys(WEIGHTS)) {
  mergedDims[k] = Math.round(combinedBase.reduce((a, r) => a + (r.dims[k] ?? 0) * r.samples, 0) / sumSamples);
}
const mergedTotal = Math.round(combinedBase.reduce((a, r) => a + r.total * r.samples, 0) / sumSamples);
const combined = {
  total: mergedTotal,
  level: mergedTotal >= 80 ? '像活人' : mergedTotal >= 60 ? '还行，仍能看出 AI' : '明显机械',
  dims: mergedDims,
  samples: reports.reduce((a, r) => a + r.samples, 0),
  messages: reports.reduce((a, r) => a + r.messages, 0),
  dist2: Math.round(combinedBase.reduce((a, r) => a + r.dist2 * r.samples, 0) / sumSamples),
  short: Math.round(combinedBase.reduce((a, r) => a + r.short * r.samples, 0) / sumSamples),
  media: Math.round(combinedBase.reduce((a, r) => a + r.media * r.samples, 0) / sumSamples),
  meta: Math.round(combinedBase.reduce((a, r) => a + r.meta * r.samples, 0) / sumSamples),
  delay: Number((combinedBase.reduce((a, r) => a + r.delay * r.samples, 0) / sumSamples).toFixed(1)),
  repeat: combinedBase.flatMap((r) => (r.repeat && r.repeat !== '无' ? [r.repeat] : [])).join(' ') || '无',
  insufficient: !scored.length,
  sessions: reports.map((r) => ({
    key: r.key, name: r.name, total: r.insufficient ? null : r.total,
    samples: r.samples, messages: r.messages, insufficient: r.insufficient,
    dims: r.dims,
  })),  source: 'social-v2',
  ts: Date.now(),
};

if (scored.length) {
  console.log('──── 合并（按样本加权）────');
  console.log(`【总分】${combined.total} / 100   ${combined.level}`);
  console.log('  各会话：' + combined.sessions.map((s) => `${s.name} ${s.insufficient ? '样本不足' : s.total + '分'}`).join(' ｜ '));
  console.log('');
} else {
  console.log(`全部会话样本都不足（<${MIN_SAMPLE} 条），这次不打总分，仅供参考。`);
}

// 给面板解析用（比正则稳，字段也全）
console.log('[[JSON]] ' + JSON.stringify(combined));
