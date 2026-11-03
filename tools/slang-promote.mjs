// slang-promote.mjs —— 把「学到了但没用上」的候选黑话升级为可用
//
// 背景：
//   自动学习只产 candidate（候选），而注入提示词时只认 confirmed。
//   结果是：她一直在学，但学到的词一个都用不上——这是整条链路的断点。
//
// 升级条件（必须同时满足，缺一不可）：
//   1. 有真实群内证据（在群里确实见过这个词）
//   2. 有可用的释义（不是「（自动学习，未审）」占位符，也不能为空）
//   3. 出现次数 ≥ 2（见过一次可能是偶然/错别字）
//
// 为什么不用 LLM 二次判断：
//   判据本身是明确的（有证据 + 有释义 + 见过多次），再加一层模型调用
//   只会引入不确定性，还得花钱。规则能表达的就不交给模型。
//
// 用法：
//   node tools/slang-promote.mjs            执行
//   node tools/slang-promote.mjs --dry-run  只看会升哪些
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'state', 'slang.json');
const DRY = process.argv.includes('--dry-run');

const MIN_COUNT = 2;
// 「（自动学习，未审）」这种占位符 = 没释义；但「（群里用法）xxx」是模型基于上下文的推断，
// 属于有价值的释义——只要去掉括号标注后还有实际内容就算通过。
const PLACEHOLDER_ONLY = /^（?(自动学习|未审|不确定|意思不明)[）]?$/;

function hasRealMeaning(meaning) {
  let m = String(meaning ?? '').trim();
  if (!m) return false;
  // 去掉开头的括号标注（（群里用法）/（意思不明）等），看剩下的内容
  const stripped = m.replace(/^（[^）]{0,12}）/, '').trim();
  if (PLACEHOLDER_ONLY.test(m) || PLACEHOLDER_ONLY.test(stripped)) return false;
  // 标注为「意思不明」的一律不升级——她自己都说不清，不该拿去用
  if (/^（意思不明）/.test(m)) return false;
  // 实际内容太短等于没解释
  if (stripped.length < 2) return false;
  return true;
}

let entries;
try {
  entries = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error('读不了 slang.json：', e.message);
  process.exit(1);
}
if (!Array.isArray(entries)) {
  console.error('slang.json 不是数组，中止');
  process.exit(1);
}

const promote = [];
const rejected = { noEvidence: [], noMeaning: [], lowCount: [] };

for (const e of entries) {
  if (e.status !== 'candidate') continue;
  const evidence = Array.isArray(e.evidence) ? e.evidence : [];
  const count = Number(e.count) || 0;

  if (!evidence.length) { rejected.noEvidence.push(e.content); continue; }
  if (!hasRealMeaning(e.meaning)) { rejected.noMeaning.push(e.content); continue; }
  if (count < MIN_COUNT) { rejected.lowCount.push(e.content); continue; }

  promote.push(e);
}

console.log(`扫描 ${entries.length} 条，其中候选 ${entries.filter((e) => e.status === 'candidate').length} 条`);
console.log(`可升级：${promote.length} 条`);
if (promote.length) {
  for (const e of promote) {
    console.log(`  ✓ ${e.content}（出现 ${e.count} 次，证据 ${e.evidence.length} 条）`);
    console.log(`     释义：${String(e.meaning).slice(0, 60)}`);
  }
}
const blocked = rejected.noEvidence.length + rejected.noMeaning.length + rejected.lowCount.length;
if (blocked) {
  console.log(`\n未升级 ${blocked} 条：`);
  if (rejected.noEvidence.length) console.log(`  无群内证据 ${rejected.noEvidence.length} 条（没在群里真见过，不该用）`);
  if (rejected.noMeaning.length) console.log(`  无有效释义 ${rejected.noMeaning.length} 条（只有占位符，不知道该什么意思）`);
  if (rejected.lowCount.length) console.log(`  出现次数不足 ${rejected.lowCount.length} 条（<${MIN_COUNT} 次，可能是偶然）`);
}

if (!promote.length) { console.log('\n没有可升级的条目。'); process.exit(0); }
if (DRY) { console.log('\n（--dry-run：未写入）'); process.exit(0); }

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
fs.copyFileSync(FILE, `${FILE}.bak-promote-${ts}`);

for (const e of promote) {
  e.status = 'confirmed';
  e.promotedAt = new Date().toISOString();
  e.promotedBy = 'auto:evidence+meaning+count';
}

fs.writeFileSync(FILE, JSON.stringify(entries, null, 2), 'utf8');
console.log(`\n已升级 ${promote.length} 条并写入。备份：slang.json.bak-promote-${ts}`);
console.log('注意：桥接需要重启才会加载新的 confirmed 列表。');
