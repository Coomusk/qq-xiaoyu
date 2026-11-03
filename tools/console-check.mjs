// console-check.mjs —— 验证拆分出来的 console 模块能独立工作
//
// 不需要跑真实桥接：用假的 deps 喂 context，用假的 req/res 喂路由，
// 检查返回的 JSON 结构是否符合预期。这是拆分安全网的第一层。
//
// 用法：node tools/console-check.mjs
import assert from 'node:assert/strict';
import { createConsoleContext, createRouter } from '../src/console/context.mjs';
import { registerStatusRoutes } from '../src/console/routes/status.mjs';
import { registerSocialReadRoutes } from '../src/console/routes/social-read.mjs';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '—', e.message); fail++; }
}

// ── 假 deps：模拟 bridge.js 会传进来的东西 ────────────────────
function makeDeps(overrides = {}) {
  const captured = [];
  const deps = {
    getCfg: () => ({ ownerQQ: 123, allow: { groups: [1], private: [2] }, closedAgentPreset: 'p1' }),
    getMode: () => 'reserved2',
    getDshReady: () => true,
    getSocialV2: () => ({ paused: false, conversations: new Map() }),
    getSessionEpoch: () => 0,
    getConsoleToken: () => 'tok',

    log: () => {},
    api: { agentPresets: { list: async () => ({ presets: [{ id: 'a', trust: 'system' }, { id: 'b' }] }) } },
    state: {},
    bot: {},
    readRoleState: () => ({ role: '小鱼', mode: 'active' }),

    sendJson: (obj, status) => captured.push({ obj, status }),
    readBody: async () => ({}),
    cors: () => {},

    tokenEq: (a, b) => a === b,
    agentTokenOk: () => true,
    isLiveAgentToken: () => true,

    canonicalV2Key: (k) => k,
    getSocialV2State: () => null,

    snowlumaHealthSnapshot: () => ({ good: true }),
    readActivityTail: (n) => ['a', 'b'].slice(0, n),
    saveSocialV2State: () => {},
    refreshAllDefaultWakeConfigsV2: () => {},
    clearAllSocialV2Timers: () => {},
    setupSleepTimerV2: () => {},
    scheduleProactiveCheckV2: () => {},
    recordSentMessagesV2: () => {},
    refreshMode: () => {},
    modeAllowed: () => true,

    readJsonSafe: () => ({}),
    atomicWriteJson: () => {},
    loadSocialV2State: () => {},
    loadSlang: () => [],
    saveSlang: () => {},
    unwrap: (r) => r,

    STATE_DIR: '/tmp',
    ROOT: '/tmp',
    VALID_MODES: ['reserved2', 'chat'],
    normalizeModeInput: (s) => s,
    REASONING_EFFORT_DEFAULT: 'max',
    ...overrides,
  };
  return { deps, captured };
}

function fakeRes() {
  return { writeHead: () => {}, end: () => {}, setHeader: () => {} };
}

console.log('══ console 模块接线检查 ══\n');

// ── 1. context 的 getter 必须是实时的，不能是快照 ──────────────
test('ctx.cfg 是实时 getter（不是快照）', () => {
  let cur = { ownerQQ: 1 };
  const { deps } = makeDeps({ getCfg: () => cur });
  const ctx = createConsoleContext(deps);
  assert.equal(ctx.cfg.ownerQQ, 1);
  cur = { ownerQQ: 2 };                    // 模拟控制台改了配置
  assert.equal(ctx.cfg.ownerQQ, 2, 'getter 应读到最新值');
});

test('ctx.socialV2 是实时 getter', () => {
  let paused = false;
  const { deps } = makeDeps({ getSocialV2: () => ({ paused }) });
  const ctx = createConsoleContext(deps);
  assert.equal(ctx.socialV2.paused, false);
  paused = true;
  assert.equal(ctx.socialV2.paused, true);
});

// ── 2. 路由表匹配 ─────────────────────────────────────────────
test('精确匹配命中', async () => {
  const { deps, captured } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  const hit = await r.dispatch('GET', '/api/status', { headers: {} }, fakeRes());
  assert.equal(hit, true);
  assert.equal(captured.length, 1);
});

test('方法不匹配则不命中', async () => {
  const { deps } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  const hit = await r.dispatch('POST', '/api/status', { headers: {} }, fakeRes());
  assert.equal(hit, false);
});

test('未知路径不命中', async () => {
  const { deps } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  const hit = await r.dispatch('GET', '/api/nope', { headers: {} }, fakeRes());
  assert.equal(hit, false);
});

// ── 3. /api/status 的字段隔离（安全关键）─────────────────────
test('管理端能拿到 ownerQQ / 白名单', () => {
  const { deps, captured } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  r.dispatch('GET', '/api/status', { headers: {} }, fakeRes());
  const body = captured[0].obj;
  assert.equal(body.ownerQQ, 123);
  assert.deepEqual(body.allowGroups, [1]);
  assert.ok(body.activity, '管理端应有 activity');
});

test('智能体拿不到 ownerQQ / 白名单 / activity', () => {
  const { deps, captured } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  r.dispatch('GET', '/api/status', { headers: { 'x-agent-token': 't' } }, fakeRes());
  const body = captured[0].obj;
  assert.equal(body.ownerQQ, undefined, '智能体绝不能看到 ownerQQ');
  assert.equal(body.allowGroups, undefined);
  assert.equal(body.activity, undefined, '智能体绝不能看到跨群活动');
  assert.equal(body.mode, 'reserved2', '但应能看到自己的模式');
});

test('x-agent-call 头也按智能体处理（无 token 时）', () => {
  const { deps, captured } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  r.dispatch('GET', '/api/status', { headers: { 'x-agent-call': '1' } }, fakeRes());
  assert.equal(captured[0].obj.ownerQQ, undefined);
});

// ── 4. readRoleState 必须每次调用 ─────────────────────────────
test('readRoleState 每请求调用一次', () => {
  let calls = 0;
  const { deps } = makeDeps({ readRoleState: () => { calls++; return { role: 'r', mode: 'active' }; } });
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  r.dispatch('GET', '/api/status', { headers: {} }, fakeRes());
  r.dispatch('GET', '/api/status', { headers: {} }, fakeRes());
  assert.equal(calls, 2, '不能缓存角色状态');
});

// ── 5. presets 路由 ───────────────────────────────────────────
test('presets 正确映射 trust 默认值', async () => {
  const { deps, captured } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerStatusRoutes(r, ctx);
  await r.dispatch('GET', '/api/presets', { headers: {} }, fakeRes());
  const body = captured[0].obj;
  assert.deepEqual(body.presets, [{ id: 'a', trust: 'system' }, { id: 'b', trust: 'system' }]);
});

console.log(`\n${pass} 通过 / ${fail} 失败`);

// ── 6. social-read 模块 ──────────────────────────────────────
test('social-read: config 命中且返回 ok', async () => {
  const { deps, captured } = makeDeps({ getCfg: () => ({ socialV2: { enabled: true } }) });
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerSocialReadRoutes(r, ctx);
  const hit = await r.dispatch('GET', '/api/socialV2/config', { headers: {} }, fakeRes());
  assert.equal(hit, true);
  assert.equal(captured[0].obj.ok, true);
  assert.equal(captured[0].obj.config.enabled, true);
});

test('social-read: 读到实时 cfg，不是快照', async () => {
  let cur = { socialV2: { autoReplyCheckMs: 30000 } };
  const { deps, captured } = makeDeps({ getCfg: () => cur });
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerSocialReadRoutes(r, ctx);
  await r.dispatch('GET', '/api/socialV2/config', { headers: {} }, fakeRes());
  cur = { socialV2: { autoReplyCheckMs: 60000 } };
  await r.dispatch('GET', '/api/socialV2/config', { headers: {} }, fakeRes());
  assert.equal(captured[1].obj.config.autoReplyCheckMs, 60000);
});

test('social-read: config 缺失时返回空对象', async () => {
  const { deps, captured } = makeDeps({ getCfg: () => ({}) });
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerSocialReadRoutes(r, ctx);
  await r.dispatch('GET', '/api/socialV2/config', { headers: {} }, fakeRes());
  assert.deepEqual(captured[0].obj.config, {});
});

test('social-read: POST 不被只读模块截胡', async () => {
  const { deps } = makeDeps();
  const ctx = createConsoleContext(deps);
  const r = createRouter();
  registerSocialReadRoutes(r, ctx);
  const hit = await r.dispatch('POST', '/api/socialV2/config', { headers: {} }, fakeRes());
  assert.equal(hit, false, 'POST 应留给 bridge.js 原逻辑');
});

process.exit(fail ? 1 : 0);
