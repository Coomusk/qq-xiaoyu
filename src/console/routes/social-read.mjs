// console/routes/social-read.mjs —— /api/socialV2 的只读查询路由（第一批）
//
// 从 bridge.js 的 startConsoleServer() 搬出，逻辑逐字未改。
// 只搬「不改状态」的端点，降低风险；写操作留到后续批次。
//
// 搬运纪律：
//   - 鉴权顺序必须与原版一致（agentToken → 会话范围 → 工具开关）
//   - 任何校验分支的错别字/文案都照抄，面板和 CLI 可能依赖它们

export function registerSocialReadRoutes(routes, ctx) {
  // GET /api/socialV2/config —— 当前生效的二代配置
  //
  // 返回 cfg.socialV2（文件 + 默认值深度合并后的运行时配置），
  // 不是 config.json 里那份原始文本——面板要靠它显示"真正生效"的值。
  routes.get('/api/socialV2/config', (req, res) => {
    ctx.sendJson({ ok: true, config: ctx.cfg.socialV2 ?? {} });
  });
}
