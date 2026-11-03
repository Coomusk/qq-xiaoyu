#!/usr/bin/env node
// status.mjs —— 小鱼运行状态与用量体检
// 看：API 调用是否正常、最近失败原因、今天烧了多少 token、按会话分布、趋势
// 用法：node tools\status.mjs           # 完整报告
//       node tools\status.mjs --watch   # 每 30 秒刷新
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'state');
const USAGE = path.join(STATE, 'token-usage.jsonl');
const BLOG = path.join(STATE, 'bridge.log');
const GUARD = path.join(STATE, 'guardian.log');

// DeepSeek 官方价（元 / 百万 token），高峰为空闲 2 倍；这里按空闲价估算
const PRICE = { cacheHit: 0.5, cacheMiss: 2, output: 8 };

function readJsonl(file, limit = Infinity) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const slice = limit === Infinity ? lines : lines.slice(-limit);
  const out = [];
  for (const l of slice) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

async function report() {
  const now = Date.now();
  const usage = readJsonl(USAGE);
  const turns = usage.filter(u => u.k === 'turn');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();
  const last1h = turns.filter(t => t.t >= now - 3600e3);
  const prev1h = turns.filter(t => t.t >= now - 7200e3 && t.t < now - 3600e3);
  const todayTurns = turns.filter(t => t.t >= todayTs);

  const sum = list => list.reduce((a, t) => {
    const b = t.b || {};
    a.cacheHit += b.cacheHit || 0;
    a.cacheMiss += b.cacheMiss || 0;
    a.output += b.output || 0;
    return a;
  }, { cacheHit: 0, cacheMiss: 0, output: 0 });

  const cost = b => (b.cacheHit / 1e6) * PRICE.cacheHit + (b.cacheMiss / 1e6) * PRICE.cacheMiss + (b.output / 1e6) * PRICE.output;

  const t1 = sum(last1h), tp = sum(prev1h), td = sum(todayTurns);

  // 按会话
  const byKey = new Map();
  for (const t of todayTurns) {
    const k = t.key || '未知';
    if (!byKey.has(k)) byKey.set(k, { n: 0, ...{ cacheHit: 0, cacheMiss: 0, output: 0 } });
    const e = byKey.get(k);
    e.n++;
    e.cacheHit += t.b?.cacheHit || 0;
    e.cacheMiss += t.b?.cacheMiss || 0;
    e.output += t.b?.output || 0;
  }

  // 最近调用时间 & 失败
  const lastTurn = turns[turns.length - 1];
  const logTail = fs.existsSync(BLOG) ? fs.readFileSync(BLOG, 'utf8').split('\n').slice(-400) : [];
  const errLines = logTail.filter(l => /错误|失败|QUOTA|429|401|timeout|超时|quota/i.test(l));
  const quotaHit = errLines.filter(l => /QUOTA|quota/i.test(l));
  const rateHit = errLines.filter(l => /429|限流|频率超限/.test(l));

  console.log('════════ 小鱼运行状态 ════════');
  console.log(`时间：${new Date().toLocaleString('zh-CN')}`);
  console.log('');

  // 1. 进程（纯 Node 检测：TCP 连一下 + 守护 PID，不调用外部命令，避免沙箱里 child_process 被拦）
  const net = await import('node:net');
  const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  const portAlive = port => new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
    const done = ok => { try { s.destroy(); } catch {} resolve(ok); };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
  const readPid = f => { try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return 0; } };
  const gpid = readPid(path.join(STATE, 'guardian.pid'));
  const p3100 = await portAlive(3100);
  const p5099 = await portAlive(5099);
  const p3000 = await portAlive(3000);
  console.log('【进程】');
  console.log(`  桥接：${p3100 ? '✅ 在跑（控制台 3100 在监听）' : '❌ 没在跑（3100 无监听）'}`);
  console.log(`  SnowLuma 网关：${p5099 && p3000 ? '✅ 在跑（5099 + OneBot 3000 都在）' : '❌ 没在跑（' + (p5099 ? '5099 在但 3000 不在' : '5099 无监听') + '）'}`);
  console.log(`  守护进程：PID ${gpid || '（空）'} → ${alive(gpid) ? '✅ 在跑' : '❌ 没在跑'}`);
  console.log('');

  // 2. 调用健康
  console.log('【API 调用健康】');
  if (lastTurn) {
    const ago = Math.round((now - lastTurn.t) / 1000);
    const agoTxt = ago < 60 ? `${ago} 秒前` : ago < 3600 ? `${Math.round(ago / 60)} 分钟前` : `${(ago / 3600).toFixed(1)} 小时前`;
    console.log(`  最后一次成功调用：${agoTxt}（${lastTurn.key}，${lastTurn.model}）`);
  } else {
    console.log('  还没有任何调用记录');
  }
  console.log(`  最近 400 行日志里的异常：${errLines.length} 条`);
  if (quotaHit.length) console.log(`  ⚠️ 命中配额/额度报错 ${quotaHit.length} 条 → 最近一条：${quotaHit[quotaHit.length - 1].trim().slice(0, 100)}`);
  if (rateHit.length) console.log(`  ⚠️ 限流/频率 ${rateHit.length} 条`);
  if (!quotaHit.length && !rateHit.length) console.log('  ✅ 未见配额或限流报错');
  console.log('');

  // 3. 用量
  const line = (label, b, n) => {
    const total = b.cacheHit + b.cacheMiss + b.output;
    console.log(`  ${label}：${n} 轮 · ${fmt(total)} tokens（输入命中 ${fmt(b.cacheHit)} / 未命中 ${fmt(b.cacheMiss)} / 输出 ${fmt(b.output)}）≈ ¥${cost(b).toFixed(3)}`);
  };
  console.log('【用量】');
  line('今天', td, todayTurns.length);
  line('最近 1 小时', t1, last1h.length);
  line('前 1 小时', tp, prev1h.length);
  if (prev1h.length && last1h.length) {
    const ratio = last1h.length / prev1h.length;
    console.log(`  调用趋势：${ratio > 1.3 ? '↑ 变快' : ratio < 0.7 ? '↓ 变慢' : '→ 持平'}（${last1h.length} vs ${prev1h.length} 轮）`);
  }
  if (todayTurns.length) {
    const perTurn = td.cacheHit + td.cacheMiss + td.output;
    console.log(`  平均每轮 ${fmt(perTurn / todayTurns.length)} tokens，今日累计 ≈ ¥${cost(td).toFixed(2)}`);
    // 按当前节奏外推到 24 点
    const hoursPassed = Math.max(0.1, (now - todayTs) / 3600e3);
    console.log(`  按现在节奏外推全天：≈ ¥${(cost(td) / hoursPassed * 24).toFixed(2)}（仅供参考）`);
  }
  console.log('');

  // 4. 按会话
  if (byKey.size) {
    console.log('【今日按会话】');
    for (const [k, v] of [...byKey.entries()].sort((a, b) => (b[1].cacheHit + b[1].cacheMiss + b[1].output) - (a[1].cacheHit + a[1].cacheMiss + a[1].output))) {
      const total = v.cacheHit + v.cacheMiss + v.output;
      console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(3)} 轮  ${fmt(total).padStart(7)} tokens  ≈ ¥${cost(v).toFixed(3)}`);
    }
    console.log('');
  }

  console.log('【说明】');
  console.log('  · 余额/剩余额度查不到（服务商侧数据），只能靠"有没有报 QUOTA / 429"判断');
  console.log('  · 出现「命中配额」就是额度用完了，去 DSH 设置页看用量或换模型');
  console.log('  · 费用按 DeepSeek 空闲价估算（命中 0.5 / 未命中 2 / 输出 8 元每百万），高峰翻倍');
}

if (process.argv.includes('--watch')) {
  const tick = async () => { console.clear(); await report(); };
  tick();
  setInterval(tick, 30000);
} else {
  await report();
}

