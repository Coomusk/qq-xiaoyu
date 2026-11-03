#!/usr/bin/env node
// list-models.mjs —— 查询 DSH 可用的模型目录
// 用法：node tools/list-models.mjs [关键词]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const kw = (process.argv[2] || '').toLowerCase();

const client = new NodeApiClient(cfg.dsh.baseUrl, 20000, {
  token: cfg.dsh.authToken || undefined,
});

let catalog;
try {
  catalog = await client.callUnary('session.modelCatalog', {});
} catch {
  catalog = await client.callUnary('session.models', {});
}
// 响应形如 { ok, value: { default, groups, routableProviders } }
// callUnary 可能已经把 result 解出来了，两种都兼容
let val = catalog?.value ?? catalog?.result?.value ?? catalog?.result ?? catalog;

const groups = val?.groups || [];
const total = groups.reduce((s, g) => s + (Array.isArray(g.models) ? g.models.length : 0), 0);

if (val?.default) {
  console.log(`DSH 默认：${val.default.provider}/${val.default.model}  (effort ${val.default.reasoningEffort})`);
}
if (Array.isArray(val?.routableProviders)) {
  console.log(`可用 provider：${val.routableProviders.join('、')}`);
}
console.log(`共 ${total} 个模型\n`);

for (const g of groups) {
  const ms = Array.isArray(g.models) ? g.models : [];
  const shown = ms.filter((m) => !kw
    || String(m.id).toLowerCase().includes(kw)
    || String(g.id).toLowerCase().includes(kw));
  if (!shown.length) continue;
  console.log(`[${g.id}] ${g.name || ''}  (${ms.length})`);
  for (const m of shown) {
    const eff = m.reasoning?.efforts?.map((e) => e.id).join('/') || '';
    console.log(`    ${m.id}  ${m.name || ''}${eff ? '   effort: ' + eff : ''}`);
  }
  console.log('');
}
