#!/usr/bin/env node
// smell-index.mjs —— 屎山指数：把技术债量化成 0~100（越高越烂）
//
// 设计原则：
//   1. 全部指标可程序化计算，不依赖主观印象
//   2. 每次运行结果写入 state/smell-index.jsonl，用于追踪改善
//   3. 分项独立打分，总分加权，任何一项改善都能在报告里看到
//
// 用法：node tools/smell-index.mjs [--save]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HISTORY = path.join(ROOT, 'state', 'smell-index.jsonl');
const SAVE = process.argv.includes('--save');

const SCAN_DIRS = ['src', 'tools', 'scripts', 'dsh', 'roles'];
const CODE_EXT = new Set(['.js', '.mjs', '.ps1', '.yml', '.vbs']);

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      // _archive / _backup-* 是清理的产物，本身不能算作脏乱
      if (it.name === 'node_modules' || it.name === '.git' || it.name === '_archive' || it.name.startsWith('_backup-')) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const all = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ── 收集源码文件（排除备份）────────────────────────────────────
const srcFiles = [];
for (const dir of SCAN_DIRS) {
  for (const f of walk(path.join(ROOT, dir))) {
    const name = path.basename(f);
    if (name.includes('.bak')) continue;
    if (name.includes('.test.')) continue;
    if (!CODE_EXT.has(path.extname(f).toLowerCase())) continue;
    let st; try { st = fs.statSync(f); } catch { continue; }
    srcFiles.push({ path: f, rel: rel(f), size: st.size, lines: 0, text: '' });
  }
}
for (const f of srcFiles) {
  try {
    f.text = fs.readFileSync(f.path, 'utf8');
    f.lines = f.text.split('\n').length;
  } catch {}
}

// ── 指标 1：单文件体量 ────────────────────────────────────────
//
// 用对数刻度而不是线性夹断。
// 为什么改：原来「超过 5000 行即 0 分」是阶梯式的——12,000 行和 6,000 行都是 0，
// 于是把 12,000 拆到 6,000 这种真实进步在指数上完全看不见，搬运过程没有反馈。
// 对数刻度让每减少一半都得到等价的分值提升：
//   300 行 → 100 分（理想上限）
//   1000 行 → 约 78
//   3000 行 → 约 52
//   12000 行 → 约 21
const IDEAL_FILE_LINES = 300;
const byLines = [...srcFiles].sort((a, b) => b.lines - a.lines);
const biggest = byLines[0] || { rel: '-', lines: 0 };
const topFileScore = clamp(
  biggest.lines <= IDEAL_FILE_LINES
    ? 100
    : 100 * (1 - Math.log(biggest.lines / IDEAL_FILE_LINES) / Math.log(120)),
  0, 100
);

// ── 指标 2：单函数跨度 ────────────────────────────────────────
function largestFunctionSpan(text) {
  const lines = text.split('\n');
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s{0,2}(async\s+)?function\s+\w+/.test(l) || /^\s{2}const\s+\w+\s*=\s*(async\s*)?\(/.test(l)) {
      starts.push(i);
    }
  }
  let max = 0, at = 0;
  for (let i = 0; i < starts.length - 1; i++) {
    const span = starts[i + 1] - starts[i];
    if (span > max) { max = span; at = starts[i] + 1; }
  }
  return { span: max, line: at, total: starts.length };
}
let worstFn = { span: 0, line: 0, file: '-', total: 0 };
for (const f of srcFiles) {
  if (!f.rel.endsWith('.js') && !f.rel.endsWith('.mjs')) continue;
  const r = largestFunctionSpan(f.text);
  if (r.span > worstFn.span) worstFn = { ...r, file: f.rel };
}
// 与文件体量同理，改成对数刻度：
//   60 行以内 → 100 分（正常函数）
//   300 行 → 约 62
//   1000 行 → 约 34
//   4000 行 → 约 6
const IDEAL_FN_LINES = 60;
const FN_SCALE = 5000;   // 分母：跨度达到这个值时接近 0 分
const fnScore = clamp(
  worstFn.span <= IDEAL_FN_LINES
    ? 100
    : 100 * (1 - Math.log(worstFn.span / IDEAL_FN_LINES) / Math.log(FN_SCALE / IDEAL_FN_LINES)),
  0, 100
);

// ── 指标 3：可测性 ────────────────────────────────────────────
// 注意：本项目测试不叫 *.test.js，而是 scripts/{test,verify,probe}-*.mjs。
// 只按 *.test.* 统计会严重低估（首版就误判成 1 个测试文件）。
const isTestFile = (p) => {
  const b = path.basename(p);
  if (/\.(test|spec)\.(mjs|js)$/.test(b)) return true;
  if (/^(test|verify|probe)-.*\.mjs$/.test(b)) return true;
  return false;
};
const testFiles = all.filter((f) => isTestFile(f) && !f.includes('node_modules'));
const prodJs = srcFiles.filter((f) => /\.(mjs|js)$/.test(f.rel) && !f.rel.startsWith('scripts/'));
const testRatio = prodJs.length ? testFiles.length / prodJs.length : 0;
const testScore = clamp(testRatio * 150, 0, 100);   // 2/3 覆盖即满分

// ── 指标 4：静默吞异常 ────────────────────────────────────────
let silentCatch = 0, totalCatch = 0;
for (const f of srcFiles) {
  if (!/\.(mjs|js)$/.test(f.rel)) continue;
  const all_ = f.text.match(/catch\s*(\([^)]*\))?\s*\{/g) || [];
  totalCatch += all_.length;
  const empty = f.text.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || [];
  silentCatch += empty.length;
}
const silentRatio = totalCatch ? silentCatch / totalCatch : 0;
const catchScore = clamp(100 - silentRatio * 200, 0, 100);

// ── 指标 5：重复实现 ──────────────────────────────────────────
// 已知的架构债，人工确认过。脚本只负责校验「是否已清理」——
// 自动猜死代码在 PowerShell（大小写不敏感、$_ 变量、. 调用）上不可靠，猜不准不如不猜。
const KNOWN_DEBT = [
  {
    id: 'send-tools',
    name: '三套发送工具并存',
    // 旧三件套与 send_message 同时注册 = 重复能力
    check: () => {
      const t = srcFiles.find((f) => f.rel.endsWith('mcp-snowluma-safe.js'))?.text || '';
      const has = (s) => new RegExp(`'${s}'`).test(t);
      return has('qq_send_group_message') && has('qq_send_message') && has('qq_send_burst');
    },
  },
  {
    id: 'dead-ctxguard',
    name: 'guardian.ps1 里的死函数 Invoke-ContextGuard',
    check: () => {
      const t = srcFiles.find((f) => f.rel.endsWith('guardian.ps1'))?.text || '';
      const defined = /function\s+Invoke-ContextGuard/.test(t);
      const called = /&\s*Invoke-ContextGuard|Invoke-ContextGuard\s+-/.test(t);
      return defined && !called;
    },
  },
];
const debtFound = KNOWN_DEBT.filter((d) => { try { return d.check(); } catch { return false; } });
const dupFindings = debtFound;
const dupScore = clamp(100 - debtFound.length * 35, 0, 100);

// ── 指标 6：仓库整洁度 ────────────────────────────────────────
// 关键区分：
//   .bak-panel-*  是面板「后悔药」功能必需的数据，每个文件留 3 份是设计，不算脏
//   .bak-<时间>   人工/脚本产生的历史快照，超过 3 份的部分才算垃圾
// state/ 里也有同样区分；只统计「超出保留策略」的部分。
const bakFiles = all.filter((f) => path.basename(f).includes('.bak'));
const BAK_KEEP = 3;                       // 每个目标文件保留份数
const bakByTarget = new Map();
for (const f of bakFiles) {
  const base = path.basename(f).replace(/\.bak.*$/, '');
  bakByTarget.set(base, (bakByTarget.get(base) || 0) + 1);
}
let bakExcess = 0;
for (const [, n] of bakByTarget) bakExcess += Math.max(0, n - BAK_KEEP);

// state 目录：只统计非 .bak 且非必需文件的「历史残留」（backup-* 是脚本自动快照）
let stateFiles = 0, stateCruft = 0;
try {
  const names = fs.readdirSync(path.join(ROOT, 'state'));
  stateFiles = names.length;
  for (const n of names) {
    if (n.startsWith('backup-')) stateCruft++;
  }
} catch {}

const todoCount = srcFiles.reduce((s, f) => s + ((f.text.match(/TODO|FIXME|HACK|XXX/g) || []).length), 0);
const tidyRaw = (bakExcess / 15) + (stateCruft / 10) + (todoCount / 15);
const tidyScore = clamp(100 - tidyRaw * 40, 0, 100);

// ── 指标 7：依赖与透明度 ──────────────────────────────────────
let depCount = 0;
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  depCount = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length;
} catch {}
const depScore = clamp(100 - Math.max(0, depCount - 10) * 4, 0, 100);

// ── 指标 8：注释密度（衡量可读性，不是越多越好）──────────────
let commentLines = 0, codeLines = 0;
for (const f of srcFiles) {
  if (!/\.(mjs|js)$/.test(f.rel)) continue;
  for (const line of f.text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) commentLines++;
    else codeLines++;
  }
}
const commentRatio = codeLines ? commentLines / codeLines : 0;
// 0.05~0.25 之间最佳，过低说明没说明，过高可能是注释噪音
const commentScore = commentRatio < 0.05
  ? clamp(commentRatio / 0.05 * 60, 0, 60)
  : commentRatio > 0.35
    ? clamp(100 - (commentRatio - 0.35) * 200, 40, 100)
    : 100;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── 加权总分（越高越烂）──────────────────────────────────────
const parts = [
  { key: '结构（单文件体量）',   weight: 18, good: topFileScore },
  { key: '结构（单函数跨度）',   weight: 12, good: fnScore },
  { key: '可测性',               weight: 20, good: testScore },
  { key: '错误处理',             weight: 15, good: catchScore },
  { key: '重复实现',             weight: 13, good: dupScore },
  { key: '仓库整洁度',           weight: 10, good: tidyScore },
  { key: '依赖健康',             weight: 5,  good: depScore },
  { key: '注释密度',             weight: 7,  good: commentScore },
];
let weightedGood = 0, weightSum = 0;
for (const p of parts) { weightedGood += p.good * p.weight; weightSum += p.weight; }
const health = weightedGood / weightSum;         // 0~100，越高越健康
const smell = Math.round(100 - health);          // 屎山指数，越高越烂

// ── 输出 ──────────────────────────────────────────────────────
const bar = (v) => {
  const n = Math.round(v / 100 * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
};
const grade = smell >= 80 ? '粪坑' : smell >= 65 ? '严重' : smell >= 50 ? '中等偏高'
  : smell >= 35 ? '中等' : smell >= 20 ? '良好' : '优秀';

console.log('══════ 屎山指数 ══════\n');
console.log(`【总分】${smell} / 100   判定：${grade}`);
console.log('（0=教科书  100=不可维护）\n');
console.log('【分项】（分数越高越健康）');
for (const p of parts) {
  console.log(`  ${p.key.padEnd(18)} ${bar(p.good)} ${String(Math.round(p.good)).padStart(3)}  权重${String(p.weight).padStart(2)}%`);
}
console.log('\n【关键事实】');
console.log(`  最大文件            ${biggest.rel}  ${biggest.lines.toLocaleString()} 行`);
console.log(`  最大函数跨度        ${worstFn.file}  L${worstFn.line}  ${worstFn.span.toLocaleString()} 行（共 ${worstFn.total} 个函数）`);
console.log(`  源码文件 / 测试文件  ${prodJs.length} / ${testFiles.length}`);
console.log(`  静默吞异常          ${silentCatch} / ${totalCatch} 处 catch`);
console.log(`  重复实现            ${dupFindings.map((d) => d.name).join('、') || '无'}`);
console.log(`  已知架构债          ${debtFound.length ? debtFound.map((d) => d.name).join('；') : '已全部清理'}`);
console.log(`  备份文件            ${bakFiles.length} 个（超出保留策略 ${bakExcess} 个）`);
console.log(`  state 历史快照      ${stateCruft} 个 / 共 ${stateFiles} 个文件`);
console.log(`  TODO/FIXME          ${todoCount} 处`);
console.log(`  依赖数量            ${depCount} 个`);
console.log(`  注释比例            ${(commentRatio * 100).toFixed(1)}%`);

const record = {
  ts: Date.now(),
  iso: new Date().toISOString(),
  smell,
  grade,
  parts: Object.fromEntries(parts.map((p) => [p.key, Math.round(p.good)])),
  facts: {
    biggestFile: biggest.rel, biggestLines: biggest.lines,
    worstFnFile: worstFn.file, worstFnSpan: worstFn.span,
    prodFiles: prodJs.length, testFiles: testFiles.length,
    silentCatch, totalCatch, backups: bakFiles.length, bakExcess,
    stateFiles, stateCruft, todoCount, depCount,
    knownDebt: debtFound.map((d) => d.name),
    commentRatio: Number(commentRatio.toFixed(3)),
  },
};

if (SAVE) {
  try {
    fs.appendFileSync(HISTORY, JSON.stringify(record) + '\n');
    console.log(`\n[已记录] ${rel(HISTORY)}`);
    const rows = fs.readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean);
    if (rows.length >= 2) {
      const prev = JSON.parse(rows[rows.length - 2]);
      const diff = smell - prev.smell;
      console.log(`[对比] 上次 ${prev.smell} → 本次 ${smell}  ${diff === 0 ? '持平' : diff > 0 ? `恶化 +${diff}` : `改善 ${diff}`}`);
    }
  } catch (e) { console.log('[记录失败]', e.message); }
} else {
  console.log('\n（加 --save 可写入历史，用于追踪改善）');
}
