#!/usr/bin/env node
// style-learn.mjs —— 群风格采样器
// 抓群里真人的最近消息，统计这群人「怎么说话」，生成画像 + 可直接注入人格卡的摘要。
// 用法：node tools\style-learn.mjs [群号] [条数=200]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const token = cfg.snowluma?.accessToken || '';
const GROUP = Number(process.argv[2] || (cfg.allow?.groups?.[0] ?? 0));
const WANT = Number(process.argv[3] || 200);
const OUT_DIR = path.resolve(ROOT, '..', '小鱼', '资料');

async function call(action, body) {
  const r = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}

function parse(m) {
  let text = '', media = 0;
  for (const seg of m.message || []) {
    const t = seg.type;
    if (t === 'text') text += seg.data?.text || '';
    else if (t === 'face') { media++; text += '[表情]'; }
    else if (t === 'mface') { media++; text += '[表情]'; }
    else if (t === 'image') { media++; text += '[图片]'; }
    else if (t === 'reply') text += '[回复]';
  }
  return { text: text.trim(), media };
}

const me = (await call('get_login_info', {})).data?.user_id;

// 优先读本地语料（group-collect 持续攒的），不够再回落到 API 历史
const CORPUS = path.join(OUT_DIR, '群消息语料.jsonl');
let msgs = [];
if (fs.existsSync(CORPUS)) {
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let a;
    try { a = JSON.parse(line); } catch { continue; }
    if (Number(a.gid) !== GROUP) continue;
    msgs.push({ uid: a.uid, nick: a.nick, time: a.time, text: a.text, media: a.media || 0, bot: !!a.bot });
  }
}
let source = '本地语料';
if (msgs.length < 20) {
  source = 'API 历史（语料不足，建议先跑 group-collect 攒）';
  const all = [];
  let cursor = undefined;
  for (let i = 0; i < 3 && all.length < WANT; i++) {
    const body = { group_id: GROUP, count: 100 };
    if (cursor) body.message_id = cursor;
    const res = await call('get_group_msg_history', body);
    const batch = res.data?.messages || [];
    if (!batch.length) break;
    all.unshift(...batch);
    cursor = batch[0]?.message_id;
    if (batch.length < 100) break;
  }
  msgs = all.slice(-WANT).map(m => ({
    uid: Number(m.sender?.user_id),
    nick: m.sender?.card || m.sender?.nickname || String(m.sender?.user_id),
    time: Number(m.time),
    ...parse(m),
    bot: Number(m.sender?.user_id) === Number(me),
  })).filter(m => m.text);
}

const humans = msgs.filter(m => !m.bot && Number(m.uid) !== Number(me) && Number(m.uid) !== 0);
if (!humans.length) { console.log('群里没抓到真人消息。'); process.exit(1); }

const lens = humans.map(m => m.text.length).sort((a, b) => a - b);
const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
const median = lens[Math.floor(lens.length / 2)];
const shortRatio = humans.filter(m => m.text.length <= 4).length / humans.length;
const mediaRatio = humans.filter(m => m.media > 0).length / humans.length;
const longRatio = humans.filter(m => m.text.length >= 40).length / humans.length;

const hasPeriod = humans.filter(m => /[。]$/.test(m.text)).length / humans.length;
const hasTilde = humans.filter(m => /[~～]/.test(m.text)).length / humans.length;
const noPunct = humans.filter(m => !/[，。！？、,.!?~～…]/.test(m.text)).length / humans.length;
const hasQuestion = humans.filter(m => /[?？]/.test(m.text)).length / humans.length;
const hasEllipsis = humans.filter(m => /…|\.\.\./.test(m.text)).length / humans.length;
const endQuestion = humans.filter(m => /[?？]$/.test(m.text)).length / humans.length;

// 高频 2~4 字片段（口头禅候选）
const frag = new Map();
for (const m of humans) {
  const t = m.text.replace(/\[[^\]]+\]/g, '').replace(/[，。！？、,.!?~～…\s]/g, '');
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= t.length; i++) {
      const s = t.slice(i, i + n);
      frag.set(s, (frag.get(s) || 0) + 1);
    }
  }
}
const catchphrases = [...frag.entries()]
  .filter(([s, c]) => c >= 3 && !/^\d+$/.test(s))
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20);

// 每个人的画像
const byUser = new Map();
for (const m of humans) {
  if (!byUser.has(m.uid)) byUser.set(m.uid, { nick: m.nick, msgs: [] });
  byUser.get(m.uid).msgs.push(m);
}
const people = [...byUser.entries()].map(([uid, v]) => ({
  uid, nick: v.nick, count: v.msgs.length,
  avgLen: +(v.msgs.reduce((a, m) => a + m.text.length, 0) / v.msgs.length).toFixed(1),
  sample: v.msgs.slice(-3).map(m => m.text.slice(0, 30)),
})).sort((a, b) => b.count - a.count);

// 分条习惯：同一人 15 秒内连发几条
const bursts = [];
let cur = null;
for (const m of humans) {
  if (cur && m.uid === cur.uid && m.time - cur.last <= 15) { cur.n++; cur.last = m.time; }
  else { if (cur) bursts.push(cur.n); cur = { uid: m.uid, n: 1, last: m.time }; }
}
if (cur) bursts.push(cur.n);
const avgBurst = bursts.length ? (bursts.reduce((a, b) => a + b, 0) / bursts.length) : 1;

const pct = x => `${Math.round(x * 100)}%`;
const report = `# 群风格画像 · ${GROUP}

> 采样 ${humans.length} 条真人消息（${people.length} 人），生成时间 ${new Date().toLocaleString('zh-CN')}

## 一句话结论

这群人说话：平均 **${avg.toFixed(0)} 字**、中位数 **${median} 字**，${pct(shortRatio)} 的消息不超过 4 个字，${pct(hasPeriod)} 用句号收尾，${pct(noPunct)} 完全不带标点，${pct(mediaRatio)} 带表情/图片。

## 硬指标（人格卡该照这个来）

| 指标 | 实测 | 说明 |
|---|---|---|
| 平均字数 | ${avg.toFixed(1)} | 她的回复应该贴着这个长度 |
| 中位字数 | ${median} | 一半的消息比这更短 |
| ≤4 字短消息 | ${pct(shortRatio)} | 真实聊天大量是这种 |
| ≥40 字长消息 | ${pct(longRatio)} | 长消息很少 |
| 带表情/图片 | ${pct(mediaRatio)} | **她的表情占比应该接近这个** |
| 句号收尾 | ${pct(hasPeriod)} | 用不用句号 |
| 完全无标点 | ${pct(noPunct)} | 不打标点的人占多少 |
| 用问号 | ${pct(hasQuestion)} | 疑问句频率 |
| 问号结尾 | ${pct(endQuestion)} | |
| 用省略号 | ${pct(hasEllipsis)} | |
| 用波浪号 ~ | ${pct(hasTilde)} | |
| 平均连发条数 | ${avgBurst.toFixed(1)} | 一次说话发几条 |

## 高频口头禅（真实词频）

${catchphrases.length ? catchphrases.map(([s, c]) => `- \`${s}\` × ${c}`).join('\n') : '- （样本不足，多攒些消息再跑）'}

## 群友画像

| 昵称 | 消息数 | 平均字数 | 最近发言 |
|---|---|---|---|
${people.map(p => `| ${p.nick} | ${p.count} | ${p.avgLen} | ${p.sample.join(' / ').replace(/\|/g, '｜')} |`).join('\n')}

---

## 可直接粘进人格卡的注入块

【这群人怎么说话（实测，别违背）】
- 一次发言平均 ${avgBurst.toFixed(1)} 条，多数时候就 1 条；总字数贴着 ${median} 字左右。
- ${pct(shortRatio)} 的消息不超过 4 个字：允许整条只有「草」「6」「?」「笑死」「确实」。
- ${pct(noPunct)} 的消息一个标点都不打；${pct(hasPeriod)} 才用句号收尾，你也不用句号。
- ${pct(mediaRatio)} 的消息带表情包/图：你在群里发消息时，大约每五条要有一条带表情。
- 群里高频口头禅：${catchphrases.slice(0, 8).map(([s]) => s).join('、') || '（样本不足）'}
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, '群风格画像.md');
fs.writeFileSync(outFile, report, 'utf8');

console.log('══════ 群风格采样完成 ══════');
console.log(`样本: ${humans.length} 条真人消息，${people.length} 人，群 ${GROUP}`);
console.log(`平均 ${avg.toFixed(1)} 字 / 中位 ${median} 字 / ≤4字 ${pct(shortRatio)} / 带表情 ${pct(mediaRatio)} / 连发 ${avgBurst.toFixed(1)} 条`);
console.log(`标点: 句号 ${pct(hasPeriod)} / 无标点 ${pct(noPunct)} / 问号 ${pct(hasQuestion)}`);
console.log('口头禅候选: ' + (catchphrases.slice(0, 10).map(([s, c]) => `${s}×${c}`).join(' ') || '无'));
console.log(`\n画像已写入: ${outFile}`);
