// console/routes/status.mjs —— /api/status 与 /api/presets
//
// 从 bridge.js 的 startConsoleServer() 搬出，逻辑未改。
// 依赖全部通过 ctx 传入，不再依赖闭包。
//
// ⚠️ 搬运纪律：只搬不改。任何逻辑变化都必须单独提交并说明原因。

export function registerStatusRoutes(routes, ctx) {
  // GET /api/status —— 运行状态
  //
  // 这个端点对「管理端」和「QQ 群里的 AI」返回**不同的字段集**，是有意的：
  // 带 x-agent-token 或 x-agent-call 的请求来自会话内的智能体，绝不能拿到
  // ownerQQ / 白名单 / activity（含其它群的发言片段）—— 否则 A 群的 AI 能读到 B 群的内容。
  routes.get('/api/status', (req, res) => {
    const rs = ctx.readRoleState();
    const isAgentCall = !!req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined;

    if (isAgentCall) {
      ctx.sendJson({
        mode: ctx.currentMode,
        role: rs?.role ?? null,
        roleMode: rs?.mode ?? 'active',
        dshReady: ctx.dshReady,
        socialV2Paused: ctx.socialV2.paused,
      });
      return;
    }

    ctx.sendJson({
      mode: ctx.currentMode,
      closedAgentPreset: ctx.cfg.closedAgentPreset ?? null,
      role: rs?.role ?? null,
      roleMode: rs?.mode ?? 'active',
      dshReady: ctx.dshReady,
      ownerQQ: ctx.cfg.ownerQQ ?? null,
      allowGroups: ctx.cfg.allow?.groups ?? [],
      allowPrivate: ctx.cfg.allow?.private ?? [],
      socialV2Paused: ctx.socialV2.paused,
      // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
      // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
      snowluma: ctx.snowlumaHealthSnapshot(),
      activity: ctx.readActivityTail(100),
    });
  });

  // GET /api/presets —— DSH 可用的 agent preset 列表
  routes.get('/api/presets', async (req, res) => {
    let presets = [];
    try {
      const { presets: list } = ctx.unwrap(await ctx.api.agentPresets.list({}), 'agentPreset.list');
      presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
    } catch {}
    ctx.sendJson({ presets });
  });
}
