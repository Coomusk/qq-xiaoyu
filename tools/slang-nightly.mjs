// 每晚给「已确认但没释义」的黑话条目补释义。
// 数据源：state/slang.json（数组）。只动 meaning/usage/example/risk/sources/updatedAt
// 和新增的 learnedAt/learnedBy；status/source/count/evidence/id 一律不碰。
// 用法：
//   node tools/slang-nightly.mjs --limit 20            # 真写
//   node tools/slang-nightly.mjs --limit 3 --dry-run   # 只打印结果，不写盘
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';
import { resolveChatSelection } from '../src/chat-model.js';
import { webSearch } from '../src/web-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLANG_FILE = path.join(ROOT, 'state', 'slang.json');
const LOG_FILE = path.join(ROOT, 'state', 'slang-nightly.log');
const PROBE_DIR = path.join(ROOT, 'state', 'slang-nightly');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = Math.max(1, Math.min(50, Number(argOf('--limit', 20)) || 20));
const DRY = argv.includes('--dry-run');
const PER_MODEL_TIMEOUT = Number(argOf('--timeout', 45000)) || 45000;
// RPC 层超时：NodeApiClient 会把它变成 fetch 的 AbortSignal.timeout()，网络请求真的会断。
// 之前挂 13 分钟就是因为 api.sessions.prompt 没被任何超时包住（await 直接挂着不返回）。
const RPC_TIMEOUT = Number(argOf('--rpc-timeout', 45000)) || 45000;
// 单条硬上限：搜索 + 模型 + 收尾，超了就记失败、下一条。
const PER_ENTRY_TIMEOUT = Number(argOf('--entry-timeout', 120000)) || 120000;
// 整晚总预算：到点就收工，剩下的留给明天（防止一条挂起把任务拖到后半夜）。
const BUDGET_MS = (Number(argOf('--budget-min', 40)) || 40) * 60 * 1000;
const SEARCH_TIMEOUT = Number(argOf('--search-timeout', 20000)) || 20000;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => { try { fs.appendFileSync(LOG_FILE, msg + '\n', 'utf8'); } catch {} };

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))]);
}

// ── DSH 地址发现 ───────────────────────────────────────────────────────────
// config.json 里的 dsh.baseUrl 只在桥接重启/守护同步时才更新；DSH 夜里重启换端口后它是旧值，
// 独立脚本直接用它就会连死端口（2026-10-31 23:00 那次就是 fetch failed）。
// 所以：先看真实监听 —— 找「DeepSeek Harness*」进程持有的 127.0.0.1 监听端口，逐个探活；
// 探不到再退回 config 里的地址。
function discoverDshBaseUrl() {
  const fallback = String(cfg.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  try {
    const netstat = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const portPids = [];
    for (const line of netstat.split('\n')) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m) portPids.push({ port: Number(m[1]), pid: m[2] });
    }
    if (!portPids.length) return { baseUrl: fallback, source: 'config(净态无监听)' };
    const tasks = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const nameByPid = new Map();
    for (const line of tasks.split('\n')) {
      const m = line.trim().match(/^"([^"]+)","(\d+)"/);
      if (m) nameByPid.set(m[2], m[1]);
    }
    const cands = portPids.filter((x) => /^DeepSeek Harness/i.test(nameByPid.get(x.pid) || ''));
    if (cands.length) {
      const pick = cands.sort((a, b) => b.port - a.port)[0];
      return { baseUrl: `http://127.0.0.1:${pick.port}`, source: `发现(pid ${pick.pid})` };
    }
  } catch { /* 落回 config */ }
  return { baseUrl: fallback, source: 'config(未发现进程)' };
}

// ── 写回：走桥接控制台接口 PATCH /api/slang/<id> ───────────────────────────
// 为什么不直接写文件：桥接存盘是拿内存整份副本覆盖，脚本直接改盘会被它下一次 saveSlang 抹掉。
// 走接口则内存+文件一起更新。
function readConsoleToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch { return ''; }
}

async function patchSlangEntry(id, patch) {
  const token = readConsoleToken();
  if (!token) throw new Error('没有 state/console-token');
  const port = Number(cfg.consolePort) || 3100;
  const res = await withTimeout(fetch(`http://127.0.0.1:${port}/api/slang/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-console-token': token },
    body: JSON.stringify(patch),
  }), 20000, 'patch');
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(`PATCH ${res.status} ${body?.error ?? ''}`.trim());
  return body.entry;
}

// 兜底：接口不可用时，重读文件、只合并本次改动（绝不拿启动时的内存副本整体覆盖）。
function mergeWriteFile(patches) {
  const fresh = JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8'));
  let n = 0;
  for (const [id, patch] of patches) {
    const e = fresh.find((x) => x.id === id);
    if (e) { Object.assign(e, patch); n += 1; }
  }
  fs.writeFileSync(SLANG_FILE, JSON.stringify(fresh, null, 2), 'utf8');
  return n;
}

// ── 备份：slang.json.bak-nightly-<yyyyMMdd-HHmm>，只留最近 5 份 ──────────────
function backup() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dest = path.join(ROOT, 'state', `slang.json.bak-nightly-${stamp}`);
  if (!DRY) fs.copyFileSync(SLANG_FILE, dest);
  const keep = 5;
  const all = fs.readdirSync(path.join(ROOT, 'state'))
    .filter((f) => f.startsWith('slang.json.bak-nightly-')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) {
    try { fs.unlinkSync(path.join(ROOT, 'state', f)); } catch {}
  }
  return dest;
}

// ── 选条：confirmed + 非 manual + 释义空/过短/占位 + 没有 learnedAt，按 count 降序 ──
function pickTargets(entries) {
  const need = (e) => {
    const m = String(e.meaning ?? '').trim();
    return !m || m.length < 8 || /自动学习/.test(m);
  };
  return entries
    .filter((e) => e && e.status === 'confirmed' && e.source !== 'manual' && !e.learnedAt && need(e))
    .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
    .slice(0, LIMIT);
}

// ── 群内语境：最多 8 条真实消息（有发言人） ────────────────────────────────
function evidenceLines(entry) {
  const ev = Array.isArray(entry.evidence) ? entry.evidence.slice(-8) : [];
  return ev.map((x) => `- ${x.sender || '群友'}：${String(x.text || '').slice(0, 100)}`);
}

async function searchSnippets(word) {
  try {
    const r = await withTimeout(webSearch(`${word} 网络用语 意思`, { root: ROOT }), SEARCH_TIMEOUT, 'search');
    const items = Array.isArray(r) ? r : (r?.results ?? []);
    return items.slice(0, 4).map((x) => ({
      title: String(x.title ?? '').slice(0, 120),
      snippet: String(x.snippet ?? x.description ?? '').slice(0, 300),
      url: String(x.url ?? ''),
    })).filter((x) => x.title || x.snippet);
  } catch {
    return [];
  }
}

function buildPrompt(entry, snippets) {
  const ev = evidenceLines(entry);
  const web = snippets.length
    ? snippets.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\n${s.url}`).join('\n')
    : '（本次联网搜索没有结果）';
  return `你在整理一个 QQ 群的黑话本。请给下面这个词补一条**人话**释义。

词：${entry.content}
出现次数：${Number(entry.count) || 0}

群里真实用法（这是最可靠的语境）：
${ev.length ? ev.join('\n') : '（没有群内语料）'}

联网搜索结果：
${web}

要求：
1. 优先用「群里真实用法」判断它在这个群里的意思；联网结果只作佐证。
2. example 优先直接引用群里那句原话；只有群里全是单蹦词（如 hhh、666）才自己造一句自然的短句。
3. 如果联网搜索没有给出可引用来源，sources 必须是空数组，且 meaning 末尾加一句「（未见外部来源，按群内用法推断）」。
4. 不确定就说不确定，不要编。普通词（今天、吃饭这种）也如实说它是普通词。
5. **必须原样回显你回答的是哪个词**：JSON 里的 "word" 字段要逐字复制上面「词：」后面的内容，
   不许改写、不许加标点、不许翻译。这一步是给脚本做配对校验用的，写错会被直接丢弃。
6. 只输出一个 JSON 对象，不要任何解释文字：
{"word":"<原词，逐字复制>","meaning":"…","usage":"…","example":"…","risk":"…","sources":["url"],"hasExternal":true}`;
}

// ── DSH 会话：整晚复用同一条，避免每词建会话 ──────────────────────────────
async function openModelSession() {
  const discovered = discoverDshBaseUrl();
  console.error(`[progress] DSH 地址：${discovered.baseUrl}（${discovered.source}，config 里是 ${cfg.dsh?.baseUrl}）`);
  const api = new NodeApiClient(discovered.baseUrl, RPC_TIMEOUT, {
    token: cfg.dsh.authToken,
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    allowRemote: cfg.dsh.allowRemote === true,
  });
  fs.mkdirSync(PROBE_DIR, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: PROBE_DIR }), 'workspace.create');
  const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
  const sessionId = created.sessionId;
  api.events.follow(sessionId);

  const collector = createTurnCollector();
  // 每条提问一个 waiter。**必须在发 prompt 之前注册**（见 ask() 的注释）。
  // waiter.turns 记录「它注册之后才开始的那些回合」——只有这些回合的 turn/end 可能是它的答案。
  const waiters = [];
  (async () => {
    try {
      for await (const envelope of api.events.mux({})) {
        const frame = envelope?.payload ?? envelope;
        if (!frame || frame.type !== 'session/event' || frame.sessionId !== sessionId) continue;
        const event = frame.event;
        if (!event) continue;
        if (event.type === 'turn/start') {
          for (const w of waiters) if (!w.closed) w.turns.add(event.data?.turn);
        }
        const ended = collector.push(event);
        if (!ended) continue;
        // 严格按回合号配对：在本条 waiter 注册之前就已存在的回合（典型是上一词超时后还在跑的
        // 「僵尸回合」）结束时一律忽略，绝不拿来当答案——2026-11-01 的错配就是这么串位的。
        const waiter = waiters.find((w) => !w.closed && w.turns.has(ended.turn));
        if (waiter) { waiter.closed = true; waiter.resolve(ended); }
      }
    } catch { /* 事件流结束就结束，不影响单次调用 */ }
  })();

  const sel = resolveChatSelection({
    followBot: cfg.dsh?.followBot,
    followBotEffort: cfg.dsh?.followBotEffort === true,
    provider: cfg.dsh?.provider,
    model: cfg.dsh?.model,
    effort: cfg.dsh?.reasoningEffort,
  });
  try {
    unwrap(await api.sessions.selectModel({ sessionId, provider: sel.provider, model: sel.model, reasoningEffort: sel.effort }), 'selectModel');
  } catch { /* 用会话默认模型也能跑 */ }

  async function ask(text) {
    const waiter = { turns: new Set(), closed: false, resolve: null };
    const endedPromise = new Promise((resolve) => { waiter.resolve = resolve; });
    // ⚠️ 先注册 waiter，再发 prompt。旧代码是先 await prompt() 再注册：
    // 模型答得快时 turn/start、turn/end 会先到，那个 waiter 永远等不到自己的回合
    // （waiter.turn 为空 → 被任何 turn/end 唤醒）→ 拿到上一条提问的答案，整批往后串一位。
    waiters.push(waiter);
    try {
      await withTimeout(api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text }] }), PER_MODEL_TIMEOUT, 'prompt');
      const ended = await withTimeout(endedPromise, PER_MODEL_TIMEOUT, 'ask');
      return String(ended.text || '');
    } finally {
      waiter.closed = true;
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
    }
  }
  // 丢弃当前会话：超时后那条回合可能还在跑，继续复用就会污染下一个词的答案。
  async function stop() {
    try { if (typeof api.stopSessionWork === 'function') await api.stopSessionWork(sessionId); } catch {}
  }
  return { api, sessionId, ask, stop };
}

function parseObject(text) {
  const raw = String(text || '').trim();
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const direct = tryParse(raw);
  if (direct && typeof direct === 'object') return direct;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return tryParse(raw.slice(start, end + 1));
  return null;
}

async function main() {
  const entries = JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8'));
  const targets = pickTargets(entries);
  const startedAt = new Date().toLocaleString('zh-CN');
  if (!targets.length) {
    log(`[${startedAt}] 处理 0 条：没有待补条目`);
    console.log('没有待补条目');
    return;
  }
  const bak = DRY ? '(dry-run 不备份/不写盘)' : backup();
  let okCount = 0;
  const failed = [];
  const done = [];
  const pendingPatches = new Map(); // 接口失败的条目，最后走本地合并写
  let fallbackUsed = false;

  let model = null;
  try {
    process.stderr.write('[progress] 创建模型会话…\n');
    model = await openModelSession();
    process.stderr.write('[progress] 模型会话就绪\n');
  } catch (error) {
    log(`[${startedAt}] 处理 ${targets.length} 条：模型会话创建失败 ${error?.message ?? error}`);
    console.error('模型会话创建失败：', error?.message ?? error);
    process.exitCode = 1;
    return;
  }

  // 总预算：到点就收工，剩下的留给明天（防止某次网络挂起把任务拖到后半夜）。
  const deadline = Date.now() + BUDGET_MS;
  for (const entry of targets) {
    if (Date.now() > deadline) {
      const left = targets.length - okCount - failed.length;
      failed.push(`剩余 ${left} 条留到明天（总预算 ${Math.round(BUDGET_MS / 60000)} 分钟用尽）`);
      break;
    }
    process.stderr.write(`[progress] ${entry.content} 搜索中…\n`);
    const snippets = await searchSnippets(entry.content);
    process.stderr.write(`[progress] ${entry.content} 搜到 ${snippets.length} 条，问模型中…\n`);
    let parsed = null;
    try {
      parsed = parseObject(await model.ask(buildPrompt(entry, snippets)));
    } catch (error) {
      const msg = String(error?.message ?? error);
      process.stderr.write(`[progress] ${entry.content} 失败：${msg}\n`);
      failed.push(`${entry.content}(${msg.slice(0, 40)})`);
      // 超时/等待失败说明那条回合可能还在跑：换一条干净会话，别让它的答案落到下一个词头上。
      if (/timeout|ask|prompt/i.test(msg)) {
        try { await model.stop(); } catch {}
        try {
          model = await openModelSession();
          process.stderr.write('[progress] 已换成新会话（上一个会话超时后作废）\n');
        } catch (e2) {
          log(`[${startedAt}] 重建模型会话失败：${e2?.message ?? e2}`);
          process.stderr.write(`[progress] 重建模型会话失败：${e2?.message ?? e2}\n`);
          failed.push(`重建会话失败(${String(e2?.message ?? e2).slice(0, 30)})`);
          break;
        }
      }
      continue;
    }
    // ── 硬校验：词必须对上 ──────────────────────────────────────────────────
    // 模型回显的词必须和这条 entry 完全一致，否则一律丢弃（不写库）。
    // 这条是防「答案串位」的最后一道闸：即使配对逻辑哪天又出问题，也不会把别人的释义写进来。
    const echoed = String(parsed?.word ?? '').trim();
    const expectWord = String(entry.content ?? '').trim();
    if (echoed !== expectWord) {
      const why = echoed ? `回显词不一致（期望「${expectWord}」，实际「${echoed}」）` : '缺 word 回显';
      log(`[${startedAt}] 丢弃 ${expectWord}：${why}｜释义前 40 字：${String(parsed?.meaning ?? '').slice(0, 40)}`);
      process.stderr.write(`[progress] ${expectWord} 丢弃：${why}\n`);
      failed.push(`${expectWord}(${why.slice(0, 30)})`);
      continue;
    }
    const meaning = String(parsed?.meaning ?? '').trim();
    if (!meaning) { failed.push(`${entry.content}(无释义)`); continue; }

    const sources = (Array.isArray(parsed?.sources) ? parsed.sources : [])
      .map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
    const hasExternal = parsed?.hasExternal === true && sources.length > 0;
    const finalMeaning = hasExternal || /未见外部来源/.test(meaning)
      ? meaning
      : `${meaning}（未见外部来源，按群内用法推断）`;

    const patch = {
      meaning: finalMeaning,
      usage: String(parsed?.usage ?? '').trim(),
      example: String(parsed?.example ?? '').trim(),
      risk: String(parsed?.risk ?? '').trim(),
      sources: hasExternal ? sources : [],
      updatedAt: new Date().toISOString(),
      learnedAt: new Date().toISOString(),
      learnedBy: 'nightly',
    };

    if (DRY) {
      done.push(`— ${entry.content}（出现 ${entry.count || 0} 次）\n   释义：${patch.meaning}\n   用法：${patch.usage || '(空)'}\n   例句：${patch.example || '(空)'}\n   风险：${patch.risk || '(无)'}\n   来源：${patch.sources.join(' , ') || '(空)'}`);
      okCount += 1;
      await sleep(500);
      continue;
    }
    // 优先走桥接接口：桥接内存和文件一起更新，之后它自己 saveSlang 也不会把这条抹掉。
    try {
      await patchSlangEntry(entry.id, patch);
      done.push(entry.content);
      okCount += 1;
    } catch (error) {
      process.stderr.write(`[progress] ${entry.content} 接口写回失败（${error?.message ?? error}），转本地合并写\n`);
      pendingPatches.set(entry.id, patch);
      fallbackUsed = true;
    }
    await sleep(500);
  }

  // 兜底路径：接口全挂时，重读文件做合并写（只覆盖本次改动的条目，不动别人）
  if (!DRY && pendingPatches.size) {
    try {
      const n = mergeWriteFile(pendingPatches);
      for (const [id] of pendingPatches) {
        const e = JSON.parse(fs.readFileSync(SLANG_FILE, 'utf8')).find((x) => x.id === id);
        if (e) { done.push(e.content); okCount += 1; }
      }
      process.stderr.write(`[progress] 本地合并写 ${n} 条\n`);
    } catch (error) {
      failed.push(`合并写失败(${String(error?.message ?? error).slice(0, 30)})`);
    }
  }

  console.log(done.join('\n'));
  const summary = `[${startedAt}] 处理 ${targets.length} 条（${targets.map((e) => e.content).join('、')}）｜成功 ${okCount}｜失败 ${failed.length}${failed.length ? `（${failed.join('、')}）` : ''}｜${DRY ? 'dry-run 未写盘' : `备份 ${path.basename(bak)}${fallbackUsed ? '（部分走本地合并写）' : '（经接口写回）'}`}`;
  log(summary);
  console.log('\n' + summary);
  // 事件流（api.events.mux）会一直挂着，不让 Node 自己退出——跑完就硬退，否则计划任务会卡死一个常驻进程。
  try { if (typeof model?.api?.stopSessionWork === 'function') await model.api.stopSessionWork(model.sessionId); } catch {}
  process.exit(0);
}

main().catch((error) => {
  log(`[${new Date().toLocaleString('zh-CN')}] 运行异常：${error?.message ?? error}`);
  console.error('运行异常：', error?.message ?? error);
  process.exit(1);
});
