// console/context.mjs —— 控制台路由的共享上下文
//
// 为什么需要这个文件：
//   startConsoleServer() 原来是一个 4,090 行的巨型函数，靠**闭包**直接访问 main() 里的
//   上百个变量和函数。拆分成多个文件后，闭包就失效了——每个路由模块必须显式拿到它需要
//   的一切。
//
// 设计原则：
//   1. 只做「打包」，不改变任何值的语义。ctx.x 原来就是闭包里的 x。
//   2. 用 getter 而不是快照：currentMode / cfg 这类值是会变的（控制台里能改模式、
//      热更新配置），快照会导致路由读到过期数据。
//   3. 缺什么就补什么，宁可 ctx 大一点，也不要让路由模块去猜。

/**
 * @param {object} deps  由 bridge.js 的 startConsoleServer 传入，键名与原来的闭包变量一致
 * @returns {object} ctx  路由模块可用的上下文
 */
export function createConsoleContext(deps) {
  const ctx = {};

  // ── 易变状态：必须用 getter，不能用快照 ──────────────────────
  Object.defineProperty(ctx, 'cfg', { get: () => deps.getCfg(), enumerable: true });
  Object.defineProperty(ctx, 'currentMode', { get: () => deps.getMode(), enumerable: true });
  Object.defineProperty(ctx, 'dshReady', { get: () => deps.getDshReady(), enumerable: true });
  Object.defineProperty(ctx, 'socialV2', { get: () => deps.getSocialV2(), enumerable: true });
  Object.defineProperty(ctx, 'sessionEpoch', { get: () => deps.getSessionEpoch(), enumerable: true });

  // ── 稳定引用：对象本身不变，内部状态会变 ────────────────────
  ctx.log = deps.log;
  ctx.api = deps.api;
  ctx.state = deps.state;
  ctx.bot = deps.bot;
  ctx.readRoleState = deps.readRoleState;   // 每次调用现场读，不是快照

  // ── HTTP 基础设施 ────────────────────────────────────────────
  ctx.sendJson = deps.sendJson;
  ctx.readBody = deps.readBody;
  ctx.cors = deps.cors;

  // ── 鉴权 ─────────────────────────────────────────────────────
  ctx.tokenEq = deps.tokenEq;
  ctx.agentTokenOk = deps.agentTokenOk;
  ctx.isLiveAgentToken = deps.isLiveAgentToken;
  ctx.consoleToken = deps.getConsoleToken;

  // ── 会话与 key ───────────────────────────────────────────────
  ctx.canonicalV2Key = deps.canonicalV2Key;
  ctx.getSocialV2State = deps.getSocialV2State;

  // ── 业务能力（路由要调用的）──────────────────────────────────
  ctx.snowlumaHealthSnapshot = deps.snowlumaHealthSnapshot;
  ctx.readActivityTail = deps.readActivityTail;
  ctx.saveSocialV2State = deps.saveSocialV2State;
  ctx.refreshAllDefaultWakeConfigsV2 = deps.refreshAllDefaultWakeConfigsV2;
  ctx.clearAllSocialV2Timers = deps.clearAllSocialV2Timers;
  ctx.setupSleepTimerV2 = deps.setupSleepTimerV2;
  ctx.scheduleProactiveCheckV2 = deps.scheduleProactiveCheckV2;
  ctx.recordSentMessagesV2 = deps.recordSentMessagesV2;
  ctx.refreshMode = deps.refreshMode;
  ctx.modeAllowed = deps.modeAllowed;

  // ── 持久化与工具 ─────────────────────────────────────────────
  ctx.readJsonSafe = deps.readJsonSafe;
  ctx.atomicWriteJson = deps.atomicWriteJson;
  ctx.loadSocialV2State = deps.loadSocialV2State;
  ctx.loadSlang = deps.loadSlang;
  ctx.saveSlang = deps.saveSlang;
  ctx.unwrap = deps.unwrap;

  // ── 常量与路径 ───────────────────────────────────────────────
  ctx.STATE_DIR = deps.STATE_DIR;
  ctx.ROOT = deps.ROOT;
  ctx.VALID_MODES = deps.VALID_MODES;
  ctx.normalizeModeInput = deps.normalizeModeInput;
  ctx.REASONING_EFFORT_DEFAULT = deps.REASONING_EFFORT_DEFAULT;

  return ctx;
}

/**
 * 简易路由表：按注册顺序匹配，第一个命中的执行。
 *
 * 为什么不用 Map（精确匹配）：现有路由里大量使用 `startsWith`（如 /api/images/xxx），
 * 顺序有语义——`/api/images/message` 必须先于 `/api/images/` 匹配。数组保序最安全。
 */
export function createRouter() {
  const routes = [];

  const add = (method, matcher, handler) => {
    routes.push({ method, matcher, handler });
  };

  return {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    // 前缀匹配，用于 /api/images/xxx 这类
    prefix: (method, pathPrefix, handler) => add(method, { prefix: pathPrefix }, handler),
    // 任意方法
    all: (matcher, handler) => add(null, matcher, handler),

    /**
     * 尝试匹配。返回 true 表示已处理（handler 内部负责写响应）。
     */
    async dispatch(method, pathname, req, res) {
      for (const r of routes) {
        if (r.method && r.method !== method) continue;
        let hit = false;
        if (typeof r.matcher === 'string') {
          hit = pathname === r.matcher;
        } else if (r.matcher.prefix) {
          hit = pathname.startsWith(r.matcher.prefix);
        } else if (r.matcher.test) {
          hit = r.matcher.test(pathname);
        }
        if (!hit) continue;
        await r.handler(req, res, pathname);
        return true;
      }
      return false;
    },

    get size() { return routes.length; },
  };
}
