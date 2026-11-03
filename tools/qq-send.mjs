#!/usr/bin/env node
// qq-send.mjs —— 绕过桥接会话令牌，直接调用 SnowLuma 的 OneBot HTTP API 发消息
// 用途：让 DSH 里的 Bot（如 qq小鱼）能代发 QQ 消息
// 用法：
//   node tools\qq-send.mjs status
//   node tools\qq-send.mjs private <QQ号> "内容"
//   node tools\qq-send.mjs group <群号> "内容"
// 安全：只允许 config.json 里 allow.private / allow.groups 列出的对象
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const httpUrl = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const token = cfg.snowluma?.accessToken || '';

async function call(action, body) {
  const r = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { http: r.status, json };
}

const [action, target, ...rest] = process.argv.slice(2);
const text = rest.join(' ');

function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

if (action === 'status') {
  const { http, json } = await call('get_login_info', {});
  console.log(JSON.stringify({ ok: http === 200 && json?.status !== 'failed', http, data: json?.data ?? json }, null, 2));
  process.exit(0);
}

if (!['private', 'group'].includes(action)) fail('用法: node tools\\qq-send.mjs status|private <QQ号>|group <群号> "内容"');
if (!target || !text.trim()) fail('缺少目标或内容');

const id = Number(target);
if (!Number.isInteger(id) || id <= 0) fail('目标必须是数字 QQ 号/群号');

const allowed = action === 'private'
  ? (cfg.allow?.private || []).map(Number)
  : (cfg.allow?.groups || []).map(Number);
if (!allowed.includes(id)) {
  fail(`拒绝：${id} 不在 config.json 的 allow.${action === 'private' ? 'private' : 'groups'} 白名单里（当前白名单: ${allowed.join(',') || '空'}）`);
}

const payload = action === 'private'
  ? { user_id: id, message: text }
  : { group_id: id, message: text };
const { http, json } = await call(action === 'private' ? 'send_private_msg' : 'send_group_msg', payload);
const ok = http === 200 && json?.status !== 'failed' && json?.retcode === 0;
console.log(JSON.stringify({ ok, http, target: `${action}:${id}`, response: json }, null, 2));
process.exit(ok ? 0 : 1);
