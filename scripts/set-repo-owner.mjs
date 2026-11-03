#!/usr/bin/env node
// 把仓库里的占位地址换成你自己的 GitHub 账号。
//
// 为什么需要它：README / package.json / issue 模板里一共 9 处写着
// `github.com/Coomusk/qq-xiaoyu`（作者的占位）。手改容易漏，漏了 issue 模板的
// 「安全问题走私密报告」链接就会指到别人仓库去。
//
// 用法：
//   node scripts/set-repo-owner.mjs 你的用户名
//   node scripts/set-repo-owner.mjs 你的用户名 仓库名      # 仓库名默认 qq-xiaoyu
//   node scripts/set-repo-owner.mjs 你的用户名 --dry-run   # 只看会改什么
//
// 只改 git 跟踪的文本文件，不会碰 state/ 或 node_modules。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_OWNER = 'coomusk';
const DEFAULT_REPO = 'qq-xiaoyu';

const argv = process.argv.slice(2).filter((a) => a !== '--dry-run');
const dryRun = process.argv.includes('--dry-run');
const owner = (argv[0] || '').trim();
const repo = (argv[1] || DEFAULT_REPO).trim();

if (!owner) {
  console.error('用法：node scripts/set-repo-owner.mjs <GitHub 用户名> [仓库名] [--dry-run]');
  console.error('例如：node scripts/set-repo-owner.mjs xiaoyu-dev');
  process.exit(2);
}
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  console.error(`用户名不合法：${owner}（GitHub 用户名只能是字母、数字、连字符，且不以连字符开头/结尾）`);
  process.exit(2);
}
if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
  console.error(`仓库名不合法：${repo}`);
  process.exit(2);
}

const OLD = `github.com/${OLD_OWNER}/${DEFAULT_REPO}`;
const NEW = `github.com/${owner}/${repo}`;

function trackedFiles() {
  const r = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('不在 git 仓库里，或 git 不可用。');
    process.exit(2);
  }
  return r.stdout.split('\n').filter(Boolean);
}

const TEXT_EXT = /\.(md|json|ya?ml|js|mjs|txt|html)$/i;
let touched = 0;
const hits = [];

for (const rel of trackedFiles()) {
  if (!TEXT_EXT.test(rel)) continue;
  const abs = path.join(ROOT, rel);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  if (!text.includes(OLD)) continue;
  const count = text.split(OLD).length - 1;
  hits.push(`${rel}  (${count} 处)`);
  touched += count;
  if (dryRun) continue;
  fs.writeFileSync(abs, text.split(OLD).join(NEW));
}

if (!hits.length) {
  console.log(`没有找到占位地址 ${OLD} —— 可能已经改过了。`);
  process.exit(0);
}

console.log(`${dryRun ? '[dry-run] 将要' : '已'}替换 ${touched} 处：`);
for (const h of hits) console.log(`  · ${h}`);
console.log(`\n${OLD}\n→ ${NEW}`);

if (!dryRun) {
  console.log('\n下一步：');
  console.log('  git add -A');
  console.log('  git commit --amend --reset-author --no-edit    # 或新建一次提交');
}
