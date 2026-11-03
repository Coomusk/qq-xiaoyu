// 线路可用性探测：对候选 provider/model 逐个发一句最小请求，记录成功/失败与耗时。
// 用法：node tools/model-probe.mjs [--timeout 60000] [provider/model] [provider/model ...]
//   - 不传 provider/model 时用下面的 CANDIDATES；
//   - 传了就以命令行为准（可带第三个字段当 effort，或写 omit 表示不传 effort）。
// 结果写到 state/model-probe.json，控制台打印表格。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const timeoutArg = process.argv.indexOf('--timeout');
const PER_MODEL_TIMEOUT = timeoutArg > 0 ? Number(process.argv[timeoutArg + 1]) : 60000;

const argCandidates = process.argv.slice(2)
  .filter((a) => a !== '--timeout' && !/^\d+$/.test(a) && /^[a-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(a))
  .map((ref) => {
    const [provider, ...rest] = ref.split('/');
    return [provider, rest.join('/')];
  });

const CANDIDATES = argCandidates.length ? argCandidates : [
  ['shushen', 'deepseek-v4.1-flash-1017', 'omit'],
];

const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken,
  tokenExplicit: cfg.dsh.authTokenExplicit === true,
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix,
  allowRemote: cfg.dsh.allowRemote === true,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label}`)), ms)),
  ]);
}

async function main() {
  const dir = path.join(ROOT, 'state', 'model-probe');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
  const sessionId = created.sessionId;
  api.events.follow(sessionId);
  console.log('probe session:', sessionId);

  // 后台消费事件流：frame = envelope.payload，frame.type === 'session/event' 才有 frame.event
  const collector = createTurnCollector();
  const waiters = [];
  (async () => {
    try {
      for await (const envelope of api.events.mux({})) {
        const frame = envelope?.payload ?? envelope;
        if (!frame || frame.type !== 'session/event') continue;
        if (frame.sessionId !== sessionId) continue;
        const event = frame.event;
        if (!event) continue;
        const waiter = waiters[waiters.length - 1];
        if (event.type === 'turn/start' && waiter && !waiter.turn) {
          waiter.turn = event.data?.turn;
        }
        const ended = collector.push(event);
        if (ended && waiter && (!waiter.turn || waiter.turn === ended.turn)) {
          waiter.resolve(ended);
        }
      }
    } catch (error) {
      console.log('event stream ended:', error?.message ?? error);
    }
  })();

  const results = [];
  for (const [provider, model, effortArg] of CANDIDATES) {
    const effort = effortArg || 'low';
    const label = `${provider}/${model}${effortArg ? ` (${effortArg})` : ''}`;
    process.stdout.write(`probe ${label} ... `);
    const started = Date.now();
    let status = 'ok';
    let detail = '';
    try {
      const selParams = { sessionId, provider, model };
      if (effort !== 'omit') selParams.reasoningEffort = effort;
      const sel = unwrap(await api.sessions.selectModel(selParams), 'selectModel');
      detail = `${sel.selected.provider}/${sel.selected.model}`;
      let waiter = null;
      try {
        await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: '只回复两个字：收到' }],
        });
        const ended = await withTimeout(new Promise((resolve) => {
          waiter = { turn: null, resolve };
          waiters.push(waiter);
        }), PER_MODEL_TIMEOUT, label);
        if (ended.reason && ended.reason.kind !== 'completed') {
          status = 'error';
          detail = `${ended.reason.kind}: ${String(ended.reason.error?.message ?? ended.reason.reason ?? '').slice(0, 200)}`;
        } else {
          detail = `reply=${(ended.text || '').trim().slice(0, 20)}`;
        }
      } finally {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
      }
    } catch (error) {
      status = 'error';
      detail = String(error?.message ?? error).slice(0, 200);
    }
    const ms = Date.now() - started;
    console.log(`${status === 'ok' ? 'OK' : 'FAIL'} ${ms}ms | ${detail}`);
    results.push({ provider, model, effort, label, status, ms, detail });
    await sleep(800);
  }

  // 收尾：停掉挂起的回合，归档探测会话
  try {
    if (typeof api.stopSessionWork === 'function') await api.stopSessionWork(sessionId);
    else if (api.sessions?.stopWork) await api.sessions.stopWork({ sessionId });
  } catch {}
  try { await api.workspace.archiveSession({ sessionId }); } catch {}
  fs.writeFileSync(path.join(ROOT, 'state', 'model-probe.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log('\n=== 汇总 ===');
  for (const r of results) {
    console.log(`${r.status === 'ok' ? '✅' : '❌'} ${r.label.padEnd(46)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('probe failed:', error?.message ?? error);
  process.exit(1);
});
