// 验证「selectModel 会改 DSH 全局默认，且 settings.replace 能把原值写回」。
// 只用一个临时会话试一次，跑完归档；不碰 QQ、不发消息。
// 用法：node tools/global-default-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken,
  tokenExplicit: cfg.dsh.authTokenExplicit === true,
  header: cfg.dsh.authHeader,
  prefix: cfg.dsh.authPrefix,
  allowRemote: cfg.dsh.allowRemote === true,
});

async function readDefault() {
  const value = unwrap(await api.callUnary('settings.describe', {}), 'settings.describe');
  const view = (value?.namespaces || []).find((n) => n?.ns === 'agent-default-model');
  return view?.value ?? null;
}

async function main() {
  const before = await readDefault();
  console.log('改动前全局默认 =', JSON.stringify(before));
  if (!before) throw new Error('读不到 agent-default-model 命名空间');

  const dir = path.join(ROOT, 'state', 'model-probe');
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'sessions.create');
  const sessionId = created.sessionId;

  try {
    const sel = unwrap(await api.sessions.selectModel({
      sessionId,
      provider: 'magpie',
      model: 'auto/deepseek-flash',
      reasoningEffort: 'low',
    }), 'selectModel');
    console.log('selectModel 返回 =', JSON.stringify(sel.selected));

    const afterSelect = await readDefault();
    console.log('改动后全局默认 =', JSON.stringify(afterSelect));
    const polluted = afterSelect && (afterSelect.provider !== before.provider || afterSelect.model !== before.model);
    console.log(polluted ? '⚠️ 全局默认被 selectModel 连带改写了（预期行为，需要还原）' : '未改写全局默认');

    if (polluted) {
      await api.callUnary('settings.replace', { ns: 'agent-default-model', section: before });
      const restored = await readDefault();
      console.log('还原后全局默认 =', JSON.stringify(restored));
      const ok = restored && restored.provider === before.provider && restored.model === before.model;
      console.log(ok ? '✅ settings.replace 还原成功 —— 桥接的"写回原值"防线可用' : '❌ 还原失败');
      if (!ok) process.exitCode = 2;
    }
  } finally {
    try { await api.sessions.stopWork({ sessionId }); } catch {}
    try { await api.workspace.archiveSession({ sessionId }); } catch {}
  }
}

main().catch((error) => {
  console.error('check failed:', error?.message ?? error);
  process.exit(1);
});
