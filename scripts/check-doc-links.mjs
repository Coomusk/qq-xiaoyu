#!/usr/bin/env node
// 文档链接检查（离线、只读）。
//
// 为什么需要它：仓库从上游 fork 过来，根目录 README 被重写过、docs/ 被裁过，
// 最容易出的问题不是代码坏，而是**文档里挂着一堆指向已删文件的链接**。
// 这类问题 CI 不会自己发现，读者点开就是 404。
//
// 检查范围：git 跟踪的 *.md，抽取 Markdown 链接里的**相对路径**（跳过 http/https、
// 锚点、mailto），确认目标存在。带 #fragment 的只校验文件本身。
//
// 用法：
//   node scripts/check-doc-links.mjs          # 全量
//   node scripts/check-doc-links.mjs --quiet  # 只输出失败
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');

function trackedMarkdown() {
  const r = spawnSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n');
  // 不是 git 仓库（例如解压出来的源码包）：退化为遍历
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'state') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  })(ROOT);
  return out;
}

const LINK_RE = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const problems = [];
let checked = 0;

for (const rel of trackedMarkdown()) {
  const abs = path.join(ROOT, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const dir = path.dirname(abs);
  for (const m of text.matchAll(LINK_RE)) {
    const raw = m[2].trim();
    if (!raw || raw.startsWith('#')) continue;
    if (/^(https?:|mailto:|tel:|data:)/i.test(raw)) continue;
    const target = raw.split('#')[0].split('?')[0];
    if (!target) continue;
    checked += 1;
    const resolved = path.resolve(dir, decodeURIComponent(target));
    if (!fs.existsSync(resolved)) {
      problems.push(`${rel} → ${raw}`);
    }
  }
}

if (!quiet) console.log(`检查了 ${checked} 个相对链接，覆盖 ${trackedMarkdown().length} 个 Markdown 文件。`);

if (problems.length) {
  console.error(`\n发现 ${problems.length} 个坏链接：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

if (!quiet) console.log('所有相对链接都指向存在的文件。');
