#!/usr/bin/env node
// 小鱼控制面板 —— 本地实时配置台
// 只监听 127.0.0.1，不引入任何第三方依赖。
// 写入前一律自动备份（<file>.bak-panel-<时间戳>）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { NodeApiClient } from '../../src/dsh-client.js';
// 和桥接共用同一套线路解析，别在面板里另写一份（否则面板显示的「实际生效」迟早和桥接不一致）
import { resolveChatSelection, readBotModelSelection } from '../../src/chat-model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PANEL_PORT || 3210);

const F = {
  config: path.join(ROOT, 'config.json'),
  guardian: path.join(ROOT, 'tools', 'guardian.ps1'),
  ctxGuard: path.join(ROOT, 'tools', 'context-guard.ps1'),
  sessions: path.join(ROOT, 'state', 'sessions.json'),
  preset: path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'),
  role: path.join(ROOT, 'roles', '小鱼.md'),
  usage: path.join(ROOT, 'state', 'token-usage.jsonl'),
  gLog: path.join(ROOT, 'state', 'guardian.log'),
  bLog: path.join(ROOT, 'state', 'bridge.log'),
  social: path.join(ROOT, 'state', 'social-v2.json'),
  innerVoice: path.join(ROOT, 'state', 'inner-voice.log'),
};

// 只屏蔽真正的凭据字段；注意别误伤 tokens / toolCount 这类统计字段
const SECRET_KEYS = /^(authToken|accessToken|consoleToken|apiKey|secret|cookie|password|mustReplyKeywords)$/i;
const SECRET_FRAG = /(access_?token|auth_?token|console_?token|api_?key|secret|cookie|password)/i;

function readText(p, def = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return def; }
}
function writeText(p, s) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // 保留原文件的换行风格，避免整文件 diff
  let out = s;
  try {
    const old = fs.readFileSync(p, 'utf8');
    if (old.includes('\r\n') && !String(s).includes('\r\n')) out = String(s).replace(/\n/g, '\r\n');
  } catch {}
  try { fs.copyFileSync(p, `${p}.bak-panel-${ts}`); } catch {}
  fs.writeFileSync(p, out, 'utf8');
}
function tailLines(p, n) {
  const lines = readText(p).split(/\r?\n/).filter(Boolean);
  return lines.slice(-n);
}
function readJson(p, def = {}) {
  try { return JSON.parse(readText(p, '{}')); } catch { return def; }
}
// 递归剔除敏感字段，避免任何 token 进到浏览器
function scrub(o) {
  if (Array.isArray(o)) return o.map(scrub);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = (SECRET_KEYS.test(k) || SECRET_FRAG.test(k)) ? '***' : scrub(v);
    }
    return out;
  }
  return o;
}

// ── 提示词块读写 ───────────────────────────────────────────────
const IND = 6;
function readPromptBlock() {
  const lines = readText(F.preset).split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*prefix:\s*>-\s*$/.test(l));
  if (i < 0) return { ok: false, error: '找不到 prefix 块' };
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') { body.push(''); continue; }
    const m = l.match(/^(\s*)/)[1].length;
    if (m < IND) break;
    body.push(l.slice(IND));
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return { ok: true, start: i + 1, body: body.join('\n'), lines };
}
function writePromptBlock(text) {
  const raw = readText(F.preset);
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*prefix:\s*>-\s*$/.test(l));
  if (start < 0) return { ok: false, error: '找不到 prefix 块' };
  let end = start + 1;
  while (end < lines.length) {
    const l = lines[end];
    if (l.trim() !== '' && l.match(/^(\s*)/)[1].length < IND) break;
    end++;
  }
  const body = String(text).replace(/\r\n/g, '\n').split('\n')
    .map((l) => (l.trim() === '' ? '' : ' '.repeat(IND) + l));
  // 原块尾部与下一节之间保留一个空行，避免往返时丢分隔
  const next = [...lines.slice(0, start + 1), ...body, '', ...lines.slice(end)];
  writeText(F.preset, next.join(eol));
  return { ok: true };
}

// ── 读取上下文用量 ─────────────────────────────────────────────
function readSessions() {
  const rows = readText(F.usage).split(/\r?\n/).filter(Boolean);
  const latest = new Map();
  for (const line of rows) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.k !== 'turn' || !o.key) continue;
    const b = o.b || {};
    const tokens = (b.cacheHit || 0) + (b.cacheMiss || 0) + (b.output || 0);
    const prev = latest.get(o.key);
    if (!prev || (o.t || 0) >= prev.t) latest.set(o.key, { t: o.t || 0, tokens, model: o.model });
  }
  // 只有 sessions.json 里登记过的会话才是「活着的」，其余是历史峰值
  const live = new Set();
  try {
    const sj = JSON.parse(readText(F.sessions, '{}'));
    for (const k of Object.keys(sj.sessions || {})) live.add(k);
  } catch {}
  return [...latest.entries()]
    .map(([key, v]) => ({ key, ...v, live: live.has(key) }))
    .sort((a, b) => (Number(b.live) - Number(a.live)) || (b.tokens - a.tokens));
}

async function state() {
  const cfg = readJson(F.config);
  // 真正生效的阈值在 context-guard.ps1 的 $LIMIT
  const g = readText(F.ctxGuard);
  const m = g.match(/\$LIMIT\s*=\s*(\d+)/);
  const p = readPromptBlock();
  const cport = Number(cfg?.consolePort) || 3100;
  const bridgeRunning = listeningPorts().has(cport);
  const paused = bridgeRunning ? await getPaused() : null;
  return {
    ctxLimit: m ? Number(m[1]) : null,
    paused,
    bridgeRunning,
    effort: cfg?.dsh?.reasoningEffort ?? null,
    model: cfg?.dsh?.model ?? null,
    provider: cfg?.dsh?.provider ?? null,
    tools: cfg?.socialV2?.tools ?? {},
    toolFlags: TOOL_META,
    prompt: p.ok ? p.body : '',
    role: readText(F.role),
    sessions: readSessions(),
    logs: { guardian: tailLines(F.gLog, 14), bridge: tailLines(F.bLog, 14) },
    paths: { root: ROOT, preset: F.preset, role: F.role, config: F.config, guardian: F.guardian },
  };
}

// 工具元信息（中文标签 + 分类），与 mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS 对应
const TOOL_META = [
  { flag: 'getPrompt', label: '读取会话提示', cat: '基础', keep: true },
  { flag: 'getUnread', label: '读未读消息', cat: '基础', keep: true },
  { flag: 'getRecent', label: '读最近消息', cat: '基础', keep: true },
  { flag: 'sendMessage', label: '发送消息', cat: '基础', keep: true },
  { flag: 'waitMessages', label: '等待消息', cat: '基础', keep: true },
  { flag: 'markRead', label: '标记已读', cat: '基础', keep: true },
  { flag: 'setWakeConfig', label: '唤醒设置', cat: '基础', keep: true },
  { flag: 'getImages', label: '看图', cat: '媒体', keep: true },
  { flag: 'sendSticker', label: '发表情', cat: '媒体', keep: true },
  { flag: 'listStickers', label: '表情列表', cat: '媒体', keep: true },
  { flag: 'getStickerImage', label: '看表情图', cat: '媒体', keep: true },
  { flag: 'collectSticker', label: '收藏表情', cat: '媒体', keep: true },
  { flag: 'stickerNote', label: '表情备注', cat: '媒体', keep: true },
  { flag: 'memory', label: '轻量记忆', cat: '记忆', keep: true },
  { flag: 'feedback', label: '反馈', cat: '其他', keep: true },
  { flag: 'socialState', label: '社交状态', cat: '其他', keep: false },
  { flag: 'sendGroup', label: '发群消息(旧)', cat: '其他', keep: false },
  { flag: 'sendPrivate', label: '发私聊(旧)', cat: '其他', keep: false },
  { flag: 'reply', label: '引用回复', cat: '其他', keep: false },
  { flag: 'sendBurst', label: '分条发送(旧)', cat: '其他', keep: false },
  { flag: 'getMyRecent', label: '自己最近发言', cat: '其他', keep: false },
  { flag: 'getMessageDetail', label: '消息详情', cat: '其他', keep: false },
  { flag: 'getActiveMembers', label: '活跃成员', cat: '其他', keep: false },
  { flag: 'slangQuery', label: '黑话查询', cat: '其他', keep: false },
  { flag: 'slangSubmit', label: '黑话提交', cat: '其他', keep: false },
  { flag: 'getForwardMsg', label: '合并转发', cat: '其他', keep: false },
  { flag: 'sendPoke', label: '拍一拍', cat: '其他', keep: false },
  { flag: 'setStickerRemark', label: '改表情备注', cat: '其他', keep: false },
  { flag: 'getSelfImage', label: '看自己形象', cat: '其他', keep: false },
  { flag: 'sendVoice', label: '语音', cat: '其他', keep: false },
];

// ── 写操作 ────────────────────────────────────────────────────
function setCtxLimit(value) {
  const n = Math.max(10000, Math.min(1000000, Math.round(Number(value) || 0)));
  const g = readText(F.ctxGuard);
  const re = /(\$LIMIT\s*=\s*)\d+/;
  if (!re.test(g)) return { ok: false, error: 'context-guard.ps1 里找不到 $LIMIT' };
  writeText(F.ctxGuard, g.replace(re, `$1${n}`));
  return { ok: true, ctxLimit: n };
}
function setTool(flag, value) {
  const cfg = readJson(F.config);
  if (!cfg?.socialV2?.tools || !(flag in cfg.socialV2.tools)) return { ok: false, error: `未知工具开关 ${flag}` };
  cfg.socialV2.tools[flag] = !!value;
  writeText(F.config, JSON.stringify(cfg, null, 2));
  return { ok: true };
}
function setEffort(value) {
  const allowed = ['none', 'low', 'medium', 'high', 'max'];
  if (!allowed.includes(value)) return { ok: false, error: '非法档位' };
  const cfg = readJson(F.config);
  cfg.dsh.reasoningEffort = value;
  writeText(F.config, JSON.stringify(cfg, null, 2));
  return { ok: true };
}
function setModel(value) {
  const cfg = readJson(F.config);
  cfg.dsh.model = String(value);
  writeText(F.config, JSON.stringify(cfg, null, 2));
  return { ok: true };
}
function setRole(text) {
  writeText(F.role, String(text));
  return { ok: true };
}
function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 120000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.slice(-2000) });
    });
  });
}

// ── 自检 ──────────────────────────────────────────────────────
function listeningPorts() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 6000, windowsHide: true });
    const set = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i);
      if (m) set.add(Number(m[1]));
    }
    return set;
  } catch { return new Set(); }
}

// 守护存活信号 = state/guardian.heartbeat（守护每分钟跑一轮，每轮都刷它）。
// ⚠️ 别再用 guardian.log 的 mtime 判活：新守护只在「有动作」时才写日志（端口漂移、拉起桥接/面板、报错），
//    夜里没事就一个字都不写，能静默十几个小时 → 误报红点。2026-11-01 10:14 实测：心跳 1 分钟，日志 542 分钟。
const GUARD_ALIVE_MIN = 3; // 与 /api/guardian 共用同一阈值，别再出现一个 3 分钟一个 10 分钟
function guardianHeartbeat() {
  const hbFile = path.join(ROOT, 'state', 'guardian.heartbeat');
  let raw = null;
  let ts = null;
  try {
    const st = fs.statSync(hbFile);
    raw = String(fs.readFileSync(hbFile, 'utf8')).trim();
    const t = Date.parse(raw);
    ts = Number.isFinite(t) ? t : st.mtimeMs; // 内容坏了就退回 mtime
  } catch { /* 文件不存在 → ts 保持 null */ }
  const ageMin = ts === null ? null : Math.round((Date.now() - ts) / 60000);
  return { raw, ageMin, alive: ageMin !== null && ageMin < GUARD_ALIVE_MIN };
}
function agoText(min) {
  if (min === null || min < 0) return '未知';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟前`;
}

async function selfCheck() {
  const out = [];
  const cfg = readJson(F.config, null);
  const add = (id, label, ok, detail, fix) => out.push({ id, label, ok, detail, fix: fix || null });

  // 1. 配置可解析
  add('config', 'config.json 可解析', !!cfg, cfg ? '结构正常' : '解析失败，文件可能损坏', null);

  // 2. 上下文阈值
  const g = readText(F.ctxGuard);
  const m = g.match(/\$LIMIT\s*=\s*(\d+)/);
  add('limit', '上下文阈值已配置', !!m, m ? `当前 ${Number(m[1]).toLocaleString()} tokens` : 'context-guard.ps1 里找不到 $LIMIT', null);

  // 3. preset patch 是否已包含当前提示词（按内容比对，不看 mtime）
  try {
    const patchPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', 'qq-chat-v2.patch.yml');
    const body = readPromptBlock().body || '';
    const norm = (s) => s.replace(/\s+/g, '');
    const patchNorm = norm(readText(patchPath));
    const inSync = !!body && patchNorm.includes(norm(body));
    add('patch', '提示词构建产物是最新的', inSync,
      inSync ? 'patch 内容与 yml 一致' : 'patch 里找不到当前提示词，需要重建', inSync ? null : 'rebuild-patch');
  } catch {
    add('patch', '提示词构建产物是最新的', false, '找不到 patch 文件', 'rebuild-patch');
  }

  // 4. 桥接存活
  const ports = listeningPorts();
  const cport = Number(cfg?.consolePort) || 3100;
  add('bridge', '桥接进程在监听控制台端口', ports.has(cport), ports.has(cport) ? `127.0.0.1:${cport}` : `端口 ${cport} 无监听`, 'restart-bridge');

  // 5. DSH 端口一致
  let dshPort = null;
  try { const u = new URL(cfg?.dsh?.baseUrl || ''); dshPort = Number(u.port); } catch {}
  const dshOk = dshPort && ports.has(dshPort);
  add('dsh', 'DSH 端口与配置一致', !!dshOk, dshPort ? (dshOk ? `127.0.0.1:${dshPort}` : `配置写的 ${dshPort} 没有监听`) : 'baseUrl 解析失败', 'restart-all');

  // 6. SnowLuma / QQ 在线
  let qq = null;
  try {
    const token = cfg?.snowluma?.accessToken || '';
    const r = await fetch('http://127.0.0.1:3000/get_login_info', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
    qq = await r.json();
  } catch {}
  const online = qq?.status === 'ok' || qq?.retcode === 0;
  add('qq', 'QQ 账号在线', online, online ? `${qq?.data?.nickname || ''}（${qq?.data?.user_id || ''}）` : 'SnowLuma 无响应或未登录', null);

  // 7. 最近一次模型调用是否新鲜
  try {
    const rows = readText(F.usage).split(/\r?\n/).filter(Boolean);
    let last = 0;
    for (const line of rows.slice(-200)) {
      try { const o = JSON.parse(line); if (o.t > last) last = o.t; } catch {}
    }
    const ageMin = last ? Math.round((Date.now() - last) / 60000) : -1;
    add('fresh', '最近有模型调用', ageMin >= 0 && ageMin < 180,
      ageMin < 0 ? '没有调用记录' : `${ageMin} 分钟前`, null);
  } catch {
    add('fresh', '最近有模型调用', false, '读不到 token-usage.jsonl', null);
  }

  // 8. 上下文体积：告警线以上只记录、不重置（压缩由 DSH compaction-basic 负责），所以「超线」本身不是故障。
  //    这一行真正的判据是「守护还活着吗」→ 只看 state/guardian.heartbeat；
  //    guardian.log 的年龄只当补充信息，静默十几个小时是正常的，不算故障。
  const lim = m ? Number(m[1]) : 50000;
  const sessions = readSessions().filter((s) => s.live);
  const over = sessions.filter((s) => s.tokens > lim);
  const hb = guardianHeartbeat();
  let actAgeMin = null;
  try { actAgeMin = Math.round((Date.now() - fs.statSync(F.gLog).mtimeMs) / 60000); } catch {}
  const ctxDetail = (over.length
    ? `${over.length} 个会话超告警线 ${lim.toLocaleString()}（仅告警，压缩由 DSH 负责）`
    : `${sessions.length} 个活跃会话均在告警线内`)
    + (actAgeMin !== null && actAgeMin >= 60 ? ` ｜ 最近一次动作 ${agoText(actAgeMin)}` : '');
  add('ctx', '上下文守护在运行', hb.alive,
    hb.alive
      ? ctxDetail
      : `守护心跳 ${hb.ageMin === null ? '读不到（state/guardian.heartbeat 不存在）' : `${agoText(hb.ageMin)}，超 ${GUARD_ALIVE_MIN} 分钟`}，守护进程可能没在跑`,
    hb.alive ? null : 'restart-all');

  return out;
}

// ── 活人感体检 ────────────────────────────────────────────────
const AUDIT_HISTORY = path.join(ROOT, 'state', 'panel-audit.jsonl');

function parseAudit(out) {
  // 优先用脚本末尾的 [[JSON]] 行：字段全（分会话、样本不足标记），比正则稳。
  // 2026-11-02 改：体检数据源换成 state/social-v2.json，输出变成「分会话 + 合并」，
  // 正则解析多个总分很容易串位，所以让脚本自己吐一份机器可读的。
  const jsonLine = /^\[\[JSON\]\]\s*(\{[\s\S]*\})\s*$/m.exec(String(out || ''));
  if (jsonLine) {
    try {
      const o = JSON.parse(jsonLine[1]);
      if (o && typeof o.total === 'number') {
        o.ts = Date.now();
        if (!Array.isArray(o.sessions)) o.sessions = [];
        return o;
      }
    } catch { /* 解析失败就走下面的旧正则兜底 */ }
  }
  // ── 旧格式兜底（万一跑的是老版本脚本）──
  const n = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
  const dims = {};
  const dimRe = /(条数分布|长度参差|短回复占比|表情使用|复读控制|句式多样|响应延迟)\s+[█░]+\s*(\d+)\s*\/100/g;
  let m;
  while ((m = dimRe.exec(out))) dims[m[1]] = Number(m[2]);
  const total = n(/总分】\s*(\d+)\s*\/\s*100/);
  if (total === null) return null;
  const legacy = {
    total,
    level: (out.match(/总分】\s*\d+\s*\/\s*100\s+(\S+)/) || [])[1] || '',
    dims,
    samples: n(/她的\s*(\d+)\s*次回复/),
    messages: n(/共\s*(\d+)\s*条消息/),
    dist2: n(/2条\s*(\d+)%/),
    short: n(/≤4 字的短回复占\s*(\d+)%/),
    media: n(/带表情\/图片的回复占\s*(\d+)%/),
    meta: n(/机械句式命中\s*\d+\s*条（(\d+)%）/),
    delay: n(/平均响应延迟\s*([\d.]+)\s*秒/),
    repeat: (out.match(/重复开头:\s*(.+)/) || [])[1]?.trim() || '',
    ts: Date.now(),
  };
  legacy.sessions = [];
  return legacy;
}

async function runAudit(save) {
  const r = await run(process.execPath, [path.join(ROOT, 'tools', 'humanize-audit.mjs')], ROOT);
  const parsed = parseAudit(r.out || '');
  if (parsed && save) {
    try {
      fs.appendFileSync(AUDIT_HISTORY, JSON.stringify(parsed) + '\n');
      // 超过 300 行就裁掉旧的，避免文件无限增长
      const rows = readText(AUDIT_HISTORY).split(/\r?\n/).filter(Boolean);
      if (rows.length > 300) fs.writeFileSync(AUDIT_HISTORY, rows.slice(-200).join('\n') + '\n', 'utf8');
    } catch {}
  }
  return { ok: !!parsed, audit: parsed, raw: parsed ? '' : (r.out || '').slice(-800) };
}

function auditHistory(limit = 40) {
  const rows = readText(AUDIT_HISTORY).split(/\r?\n/).filter(Boolean);
  const out = [];
  for (const line of rows.slice(-200)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out.slice(-limit);
}

// ── 会话操作 ──────────────────────────────────────────────────
async function resetSession(key) {
  if (!/^(group|private):\d+$/.test(String(key || ''))) return { ok: false, error: '会话 key 不合法' };
  const cfg = readJson(F.config);
  const port = Number(cfg?.consolePort) || 3100;
  const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
  if (!token) return { ok: false, error: '缺少 console-token' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/session/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': token },
      body: JSON.stringify({ key, confirm: true }),
      signal: AbortSignal.timeout(15000),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function notebookPath(key) {
  if (!/^(group|private):\d+$/.test(String(key || ''))) return null;
  const safe = String(key).replace(':', '-');
  return path.join(ROOT, '..', '小鱼', '资料', '学习本', `${safe}.md`);
}

// ── 备份 ──────────────────────────────────────────────────────
const BACKUP_TARGETS = [
  { id: 'config', label: 'config.json', p: F.config },
  { id: 'role', label: 'roles/小鱼.md', p: F.role },
  { id: 'prompt', label: 'agent.cordis.yml', p: F.preset },
  { id: 'ctx', label: 'context-guard.ps1', p: F.ctxGuard },
  { id: 'guardian', label: 'guardian.ps1', p: F.guardian },
];

function listBackups() {
  const out = [];
  for (const t of BACKUP_TARGETS) {
    const dir = path.dirname(t.p);
    const base = path.basename(t.p);
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith(base + '.bak')); } catch {}
    const items = names.map((n) => {
      const full = path.join(dir, n);
      let st = null; try { st = fs.statSync(full); } catch {}
      return { name: n, file: t.id, full, size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
    }).sort((a, b) => b.mtime - a.mtime).slice(0, 6);
    out.push({ ...t, p: undefined, items });
  }
  return out;
}

function restoreBackup(fileId, name) {
  const t = BACKUP_TARGETS.find((x) => x.id === fileId);
  if (!t) return { ok: false, error: '未知文件' };
  if (!/\.bak[-.\w]*$/.test(name)) return { ok: false, error: '备份名不合法' };
  const dir = path.dirname(t.p);
  const src = path.join(dir, name);
  if (path.dirname(src) !== dir) return { ok: false, error: '路径越界' };
  if (!fs.existsSync(src)) return { ok: false, error: '备份不存在' };
  try {
    fs.copyFileSync(t.p, `${t.p}.bak-before-restore-${Date.now()}`);
    fs.copyFileSync(src, t.p);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── 资产 ──────────────────────────────────────────────────────
function assets() {
  const out = { slang: 0, slangConfirmed: 0, slangCap: 0, stickers: 0, notebooks: [] };
  try {
    const s = JSON.parse(readText(path.join(ROOT, 'state', 'slang.json'), '[]'));
    const list = Array.isArray(s) ? s : (s.terms || s.words || Object.values(s));
    out.slang = list.length;
    out.slangConfirmed = list.filter((x) => x && x.status === 'confirmed').length;
  } catch {}
  try {
    const m = readText(path.join(ROOT, 'src', 'slang-learner.js')).match(/SLANG_MAX_ENTRIES\s*=\s*(\d+)/);
    if (m) out.slangCap = Number(m[1]);
  } catch {}
  try {
    const s = JSON.parse(readText(path.join(ROOT, 'state', 'stickers.json'), '[]'));
    out.stickers = Array.isArray(s) ? s.length : Object.keys(s).length;
  } catch {}
  try {
    const dir = path.join(ROOT, '..', '小鱼', '资料', '学习本');
    out.notebooks = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.md') && !n.includes('.bak'))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { name: n, key: n.replace(/\.md$/, '').replace('-', ':'), size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  return out;
}

// ── 模型列表与切换 ────────────────────────────────────────────
// 面板是常驻进程，而 DSH 每次重启都会换端口。
// 所以不能只在第一次调用时创建客户端：地址一变就必须重建，否则面板会一直
// 朝着已经关掉的那个端口发请求，表现为模型页 500（fetch failed）。
// 这与桥接里的 syncDshBaseUrl 是同一类问题，必须两边都做。
let dshClient = null;
let dshClientBase = null;
function getDsh() {
  const cfg = readJson(F.config);
  const base = String(cfg?.dsh?.baseUrl || '').trim();
  if (!base) throw new Error('config.json 里缺少 dsh.baseUrl');
  if (!dshClient || dshClientBase !== base) {
    dshClient = new NodeApiClient(base, 20000, { token: cfg.dsh.authToken || undefined });
    dshClientBase = base;
  }
  return dshClient;
}

// 从 DSH 的模型目录里拉可用模型，扁平化成「provider/model」一行一条
async function listModels() {
  const client = getDsh();
  let raw;
  try {
    raw = await client.callUnary('session.modelCatalog', {});
  } catch {
    raw = await client.callUnary('session.models', {});
  }
  const val = raw?.value ?? raw?.result?.value ?? raw?.result ?? raw;
  const groups = val?.groups || [];
  const list = [];
  for (const g of groups) {
    for (const m of (g.models || [])) {
      list.push({
        provider: g.id,
        id: m.id,
        ref: `${g.id}/${m.id}`,
        name: m.name || m.id,
        groupName: g.name || g.id,
        efforts: (m.reasoning?.efforts || []).map((e) => e.id),
      });
    }
  }
  return { list, default: val?.default || null, providers: val?.routableProviders || [] };
}

// 当前生效的模型（config 里写的 + 各 live 会话实际绑定的）
function currentModelInfo() {
  const cfg = readJson(F.config);
  const sessions = readJson(F.sessions, {}).sessions || {};
  return {
    provider: cfg?.dsh?.provider ?? null,
    model: cfg?.dsh?.model ?? null,
    effort: cfg?.dsh?.reasoningEffort ?? null,
    liveSessions: Object.entries(sessions).map(([key, sid]) => ({ key, sessionId: sid })),
  };
}

// 「实际生效」= 和桥接 ensureChatModel 完全同一套解析（followBot 优先，config 是兜底）。
// 面板以前只显示 config 那个值，于是 2026-11-01 凌晨看着是 group/contact-api、实际跑的是 dfmodel，
// 把人绕进去了 —— 现在两个都显示，不一致就标出来。
function effectiveChatModel() {
  const cfg = readJson(F.config) || {};
  const followBot = cfg?.dsh?.followBot;
  try {
    const bot = readBotModelSelection({ followBot });
    const r = resolveChatSelection({
      followBot,
      followBotEffort: cfg?.dsh?.followBotEffort === true,
      provider: cfg?.dsh?.provider,
      model: cfg?.dsh?.model,
      effort: cfg?.dsh?.reasoningEffort,
    });
    return {
      ref: `${r.provider}/${r.model}`,
      provider: r.provider,
      model: r.model,
      effort: r.effort,
      source: r.source, // 'followBot:<名字>' 或 'config'
      followBot: bot?.ref || null, // Bot 注册表里那个 Bot 的模型
      botError: bot?.error || null,
      warning: r.warning || null,
    };
  } catch (e) {
    return { ref: null, source: null, error: String(e?.message || e) };
  }
}

// 切模型：写 config + 对所有 live 会话直接调 selectModel
// 为什么必须直接调：桥接的 ensureChatModel 有 modelAppliedSessions 缓存，
// 且只在「下一轮开始」时才应用；群里一直在跑回合时永远等不到那个窗口。
async function switchModel({ provider, model, effort, applyToSessions }) {
  const cfg = readJson(F.config);
  cfg.dsh = { ...(cfg.dsh ?? {}), provider, model };
  if (effort) cfg.dsh.reasoningEffort = effort;
  writeText(F.config, JSON.stringify(cfg, null, 2));

  const results = [];
  if (applyToSessions) {
    const client = getDsh();
    const sessions = readJson(F.sessions, {}).sessions || {};
    for (const [key, sid] of Object.entries(sessions)) {
      try {
        const r = await client.callUnary('session.selectModel', {
          sessionId: sid,
          provider,
          model,
          reasoningEffort: effort || cfg.dsh.reasoningEffort || 'low',
        });
        const ok = r?.result?.ok !== false;
        const sel = r?.value?.selected ?? r?.result?.value?.selected;
        results.push({ key, ok, selected: sel || null, error: ok ? null : r?.result?.error?.message });
      } catch (e) {
        results.push({ key, ok: false, error: String(e?.message || e) });
      }
    }
  }
  return { ok: true, applied: results };
}

// ── 暂停发送 / 全停 / 全启 ────────────────────────────────────
let pauseCache = { at: 0, value: null };

async function bridgeCall(method, pathname, body) {
  const cfg = readJson(F.config);
  const port = Number(cfg?.consolePort) || 3100;
  const token = readText(path.join(ROOT, 'state', 'console-token')).trim();
  if (!token) throw new Error('缺少 console-token');
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  return r.json().catch(() => ({ ok: r.ok }));
}

async function getPaused(force) {
  const now = Date.now();
  if (!force && pauseCache.value !== null && now - pauseCache.at < 2000) return pauseCache.value;
  try {
    const d = await bridgeCall('GET', '/api/socialV2/activity');
    pauseCache = { at: now, value: d?.paused === true };
  } catch {
    pauseCache = { at: now, value: null };
  }
  return pauseCache.value;
}

async function setPaused(paused) {
  const d = await bridgeCall('POST', '/api/socialV2/activity', { paused: !!paused });
  pauseCache = { at: Date.now(), value: d?.paused === true };
  return { ok: d?.ok !== false, paused: pauseCache.value };
}

// 停：先停守护（否则它 15 秒内又把桥接拉起来），再停 start.bat 的重启循环，最后停桥接
// 绝不能杀面板自己（node ...panel/server.mjs）和调用本函数的 pwsh
async function stopAll() {
  const self = process.pid;
  const ps = [
    '$k=@()',
    `$self=${self}`,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'pwsh.exe' -and $_.CommandLine -match 'guardian\\.ps1' } | ForEach-Object { $k += ('guardian:' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'Start-Sleep -Milliseconds 600',
    "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -match 'start\\.bat' } | ForEach-Object { $k += ('loop:' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'Start-Sleep -Milliseconds 600',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bridge\\.js' -and $_.ProcessId -ne $self } | ForEach-Object { $k += ('bridge:' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    '$k -join ","',
  ].join('; ');
  const r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], ROOT);
  pauseCache = { at: 0, value: null };
  return { ok: r.ok, stopped: (r.out || '').trim() };
}

async function startAll() {
  const guard = path.join(ROOT, 'tools', 'guardian.ps1');
  const ps = `Start-Process -FilePath 'pwsh.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${guard}' -WorkingDirectory '${ROOT}' -WindowStyle Hidden; 'started'`;
  const r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], ROOT);
  return { ok: r.ok, out: (r.out || '').trim() };
}

// ── HTTP ──────────────────────────────────────────────────────
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
function body(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    const html = readText(path.join(__dirname, 'index.html'), '<h1>index.html 缺失</h1>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (p === '/simple' || p === '/simple.html') {
    const html = readText(path.join(__dirname, 'index-simple.html'), '<h1>index-simple.html 缺失</h1>');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(html);
  }

  if (p === '/api/state') return json(res, 200, scrub(await state()));

  // 守护心跳：guardian 每分钟跑一轮会刷新 state/guardian.heartbeat。
  // 超过 3 分钟没更新 = 守护没在跑（2026-10-31 它死了 4 小时没人知道）。只读文件，不写。
  // 注意：判据是 heartbeat，不是 guardian.log —— 日志只在有动作时才写。
  if (p === '/api/guardian') {
    const hb = guardianHeartbeat();
    return json(res, 200, {
      ok: hb.alive,
      at: hb.raw,
      ageMin: hb.ageMin,
      // missing = 没启用；stale = 超时；ok = 正常
      state: hb.ageMin === null ? 'missing' : (hb.alive ? 'ok' : 'stale'),
      // 面板自愈开关：state/panel-guardian.off 存在 = 关闭（关掉不是故障，前端显示灰色不要标红）
      panelGuardian: fs.existsSync(path.join(ROOT, 'state', 'panel-guardian.off')) ? 'off' : 'on',
    });
  }

  if (p === '/api/power') {
    const running = listeningPorts().has(Number(readJson(F.config)?.consolePort) || 3100);
    return json(res, 200, { bridgeRunning: running, paused: running ? await getPaused(true) : null });
  }
  if (p === '/api/pause' && req.method === 'POST') {
    const b = await body(req);
    try {
      const r = await setPaused(b.paused);
      return json(res, 200, r);
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e?.message || e) });
    }
  }
  if (p === '/api/shutdown' && req.method === 'POST') {
    const r = await stopAll();
    return json(res, 200, r);
  }
  if (p === '/api/startup' && req.method === 'POST') {
    const r = await startAll();
    return json(res, 200, r);
  }

  if (p === '/api/audit') {
    const r = await runAudit(true);
    return json(res, 200, { ...r, history: auditHistory() });
  }
  if (p === '/api/audit/history') return json(res, 200, { history: auditHistory() });

  if (p === '/api/notebook') {
    const np = notebookPath(url.searchParams.get('key'));
    if (!np) return json(res, 400, { error: 'key 不合法' });
    return json(res, 200, { text: readText(np, ''), exists: fs.existsSync(np) });
  }

  // 内心独白：她醒来读完消息、决定这次不发言时写下的完整思考。
  // 只读最近 N 条，不做分页——目前一天几十条，翻到顶就够了。
  if (p === '/api/inner-voice') {
    const want = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    const raw = readText(F.innerVoice, '');
    // 文件格式是「[时间] 元信息\n  正文\n」两行一条，按行首 '[' 切块再取末尾 want 块。
    const blocks = [];
    for (const line of raw.split(/\r?\n/)) {
      if (/^\[/.test(line)) blocks.push(line);
      else if (blocks.length) blocks[blocks.length - 1] += `\n${line}`;
    }
    const picked = blocks.filter((b) => b.trim()).slice(-want);
    return json(res, 200, {
      exists: fs.existsSync(F.innerVoice),
      total: picked.length,
      text: picked.join('\n'),
    });
  }

  // ── 黑话本 ────────────────────────────────────────────────────────────
  // 黑话库的增删改全在桥接里（它持有内存中的 slangEntries，改完立即生效，
  // 而且下次学习时也以内存为准）。面板这边**只做转发**，不自己读写 slang.json ——
  // 否则两头各写一份，桥接一保存就把面板的改动盖掉。
  if (p === '/api/slang') {
    if (req.method === 'GET') {
      const q = url.searchParams.get('status') || '';
      try { return json(res, 200, await bridgeCall('GET', `/api/slang${q ? `?status=${encodeURIComponent(q)}` : ''}`)); }
      catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
    }
    if (req.method === 'POST') {
      try { return json(res, 200, await bridgeCall('POST', '/api/slang', await body(req))); }
      catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
    }
  }
  if (p === '/api/slang/batch-confirm' && req.method === 'POST') {
    try { return json(res, 200, await bridgeCall('POST', '/api/slang/batch-confirm', await body(req))); }
    catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
  }
  if (p === '/api/slang/batch-reject' && req.method === 'POST') {
    try { return json(res, 200, await bridgeCall('POST', '/api/slang/batch-reject', await body(req))); }
    catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
  }
  if (p === '/api/slang/batch-delete' && req.method === 'POST') {
    try { return json(res, 200, await bridgeCall('POST', '/api/slang/batch-delete', await body(req))); }
    catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
  }
  // 批量降级：桥接只提供 batch-confirm / batch-reject，没有 confirmed→candidate 的批量入口，
  // 所以这里逐个 PATCH 过去。串行是因为桥接每次 PATCH 都会整体重写 slang.json，
  // 并发写同一文件会互相覆盖。
  if (p === '/api/slang/batch-demote' && req.method === 'POST') {
    const b = await body(req);
    const ids = Array.isArray(b.ids) ? b.ids.map(String).filter(Boolean) : [];
    if (!ids.length) return json(res, 400, { ok: false, error: '请选择要降级的黑话' });
    let ok = 0;
    const failed = [];
    for (const id of ids) {
      try {
        const r = await bridgeCall('PATCH', `/api/slang/${encodeURIComponent(id)}`, { status: 'candidate' });
        if (r?.ok === false) failed.push({ id, error: r.error || '失败' });
        else ok += 1;
      } catch (e) {
        failed.push({ id, error: String(e?.message || e) });
      }
    }
    return json(res, 200, { ok: true, demotedCount: ok, failedCount: failed.length, failed: failed.slice(0, 20) });
  }
  // 单条改状态：降级（confirmed→candidate）、恢复、拒绝，都走桥接的 PATCH。
  if (p.startsWith('/api/slang/') && req.method === 'POST') {
    const id = decodeURIComponent(p.slice('/api/slang/'.length));
    if (!id || id.includes('/')) return json(res, 400, { error: 'id 不合法' });
    const b = await body(req);
    if (!['candidate', 'confirmed', 'rejected'].includes(b.status)) {
      return json(res, 400, { error: 'status 只能是 candidate/confirmed/rejected' });
    }
    try { return json(res, 200, await bridgeCall('PATCH', `/api/slang/${encodeURIComponent(id)}`, { status: b.status })); }
    catch (e) { return json(res, 502, { error: String(e?.message || e) }); }
  }

  if (p === '/api/assets') return json(res, 200, assets());
  if (p === '/api/backups') return json(res, 200, { targets: listBackups() });

  if (p === '/api/models') {
    try {
      const d = await listModels();
      return json(res, 200, { ...d, current: { ...currentModelInfo(), effective: effectiveChatModel() } });
    } catch (e) {
      return json(res, 500, { error: String(e?.message || e) });
    }
  }

  if (p === '/api/model/switch' && req.method === 'POST') {
    const b = await body(req);
    if (!b.provider || !b.model) return json(res, 400, { ok: false, error: '缺 provider 或 model' });
    try {
      const r = await switchModel({
        provider: String(b.provider),
        model: String(b.model),
        effort: b.effort ? String(b.effort) : null,
        applyToSessions: b.applyToSessions !== false,
      });
      return json(res, 200, r);
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (p === '/api/restore' && req.method === 'POST') {
    const b = await body(req);
    const r = restoreBackup(b.file, b.name);
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/session/reset' && req.method === 'POST') {
    const b = await body(req);
    const r = await resetSession(b.key);
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/selfcheck') {
    try { return json(res, 200, { checks: await selfCheck() }); }
    catch (e) { return json(res, 500, { error: String(e?.message || e) }); }
  }

  if (p === '/api/fix' && req.method === 'POST') {
    const b = await body(req);
    let r;
    if (b.action === 'rebuild-patch') {
      r = await run(process.execPath, [path.join(ROOT, 'scripts', 'build-agent-preset-patches.mjs')], ROOT);
    } else if (b.action === 'restart-bridge') {
      r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'restart-bridge.ps1')], ROOT);
    } else if (b.action === 'restart-all') {
      r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'restart-all.ps1')], ROOT);
    } else {
      r = { ok: false, out: `未知修复动作 ${b.action}` };
    }
    return json(res, r.ok ? 200 : 500, r);
  }

  if (p === '/api/save' && req.method === 'POST') {
    const b = await body(req);
    let r;
    switch (b.field) {
      case 'ctxLimit': r = setCtxLimit(b.value); break;
      case 'tool': r = setTool(b.flag, b.value); break;
      case 'effort': r = setEffort(b.value); break;
      case 'model': r = setModel(b.value); break;
      case 'role': r = setRole(b.value); break;
      case 'prompt': {
        const w = writePromptBlock(b.value);
        if (!w.ok) { r = w; break; }
        const build = await run(process.execPath, [path.join(ROOT, 'scripts', 'build-agent-preset-patches.mjs')], ROOT);
        r = { ok: true, build: build.out };
        break;
      }
      default: r = { ok: false, error: `未知字段 ${b.field}` };
    }
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/restart' && req.method === 'POST') {
    const b = await body(req);
    const script = b.target === 'all' ? 'restart-all.ps1' : 'restart-bridge.ps1';
    const r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', script)], ROOT);
    return json(res, 200, r);
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[panel] 小鱼控制面板 → http://127.0.0.1:${PORT}`);
  console.log(`[panel] 项目根目录 ${ROOT}`);
});
