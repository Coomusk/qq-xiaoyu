#!/usr/bin/env node
// group-collect.mjs —— 群消息持续采集器
// 把所有群的新消息追加进本地语料（按 message_id 去重），供风格学习与黑话提炼使用。
// 用法：node tools\group-collect.mjs           # 采集一轮
//       node tools\group-collect.mjs --all     # 列出采集统计
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const token = cfg.snowluma?.accessToken || '';
const OUT_DIR = path.resolve(ROOT, '..', '小鱼', '资料');
const CORPUS = path.join(OUT_DIR, '群消息语料.jsonl');
const MAX_PER_RUN = 300;

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
  }
  return { text: text.trim(), media };
}

const existing = new Set();
if (fs.existsSync(CORPUS)) {
  for (const line of fs.readFileSync(CORPUS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { existing.add(JSON.parse(line).id); } catch {}
  }
}

const me = (await call('get_login_info', {})).data?.user_id;
const allGroups = (await call('get_group_list', {})).data || [];

// 采集范围必须是显式白名单，且**只能收窄，不能放宽**。
//
// 曾经的行为：collectGroups 未配置时采**所有群**——机器人被拉进的任何群
// （直播通知群、别人的朋友群…）都会被静默抓取。这是真实的隐私事故，
// 语料里曾残留 355 条非白名单群的消息。
// 现在的规则：
//   ① 优先 collectGroups（显式声明采哪些）
//   ② 没配则退回 allow.groups（允许说话的群）
//   ③ 两者都空 ⇒ 直接退出，绝不"默认全采"
//   ④ collectGroups 里若写了 allow.groups 之外的群，仍然取交集
const explicit = Array.isArray(cfg.collectGroups) && cfg.collectGroups.length
  ? cfg.collectGroups.map(Number)
  : null;
const allowed = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.map(Number) : [];
const only = explicit ?? (allowed.length ? allowed : null);

if (!only || !only.length) {
  console.error('拒绝采集：config.json 既没配 collectGroups，也没配 allow.groups。');
  console.error('为避免抓取无关群聊，本脚本不会在"无白名单"时运行。');
  process.exit(2);
}
const groups = allGroups.filter((g) => only.includes(Number(g.group_id))
  && (!allowed.length || allowed.includes(Number(g.group_id))));
if (!groups.length) {
  console.log('没有匹配白名单的群，本轮无采集。');
  process.exit(0);
}
console.log(`采集范围（${groups.length} 个）：${groups.map((g) => g.group_name).join('、')}`);
const added = [];
const perGroup = [];

for (const g of groups) {
  const res = await call('get_group_msg_history', { group_id: g.group_id, count: 100 });
  const msgs = res.data?.messages || [];
  let n = 0;
  for (const m of msgs) {
    const id = String(m.message_id ?? '');
    if (!id || existing.has(id)) continue;
    const { text, media } = parse(m);
    if (!text) continue;
    existing.add(id);
    added.push({
      id,
      gid: Number(g.group_id),
      gname: g.group_name,
      uid: Number(m.sender?.user_id),
      nick: m.sender?.card || m.sender?.nickname || '',
      bot: Number(m.sender?.user_id) === Number(me),
      time: Number(m.time),
      text,
      media,
    });
    n++;
    if (added.length >= MAX_PER_RUN) break;
  }
  perGroup.push({ gid: g.group_id, name: g.group_name, fetched: msgs.length, added: n });
  if (added.length >= MAX_PER_RUN) break;
}

if (added.length) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.appendFileSync(CORPUS, added.map(a => JSON.stringify(a)).join('\n') + '\n', 'utf8');
}

if (process.argv.includes('--all')) {
  const all = fs.existsSync(CORPUS)
    ? fs.readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const byG = new Map();
  for (const a of all) byG.set(a.gname, (byG.get(a.gname) || 0) + 1);
  console.log(`语料总计: ${all.length} 条`);
  for (const [n, c] of byG) console.log(`  ${n}: ${c} 条`);
  console.log(`文件: ${CORPUS}`);
} else {
  console.log(`本轮新增 ${added.length} 条（语料共 ${existing.size} 条）`);
  for (const p of perGroup) console.log(`  ${p.name}: 拉到 ${p.fetched} 条，新增 ${p.added}`);
  console.log(`文件: ${CORPUS}`);
}

