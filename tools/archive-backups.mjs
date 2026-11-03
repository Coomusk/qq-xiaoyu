#!/usr/bin/env node
// archive-backups.mjs —— 归档超出保留策略的 .bak 文件
//
// 规则：每个「目标文件」保留最近 3 份备份，其余移到 _archive/backups/<原目录>/
// 理由：面板「后悔药」只显示每个文件最近 3 份，多出来的从不被读取。
//
// 用法：
//   node tools/archive-backups.mjs --dry-run    只看不动
//   node tools/archive-backups.mjs              执行
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ARCHIVE = path.join(ROOT, '_archive', 'backups');
const KEEP = 3;
const DRY = process.argv.includes('--dry-run');

const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', '_backup-20261028-214951']);

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walk(path.join(dir, it.name), out);
    } else if (it.name.includes('.bak')) {
      out.push(path.join(dir, it.name));
    }
  }
  return out;
}

const files = walk(ROOT);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// 按「同目录 + 同目标文件」分组
const groups = new Map();
for (const f of files) {
  const dir = path.dirname(f);
  const base = path.basename(f).replace(/\.bak.*$/, '');
  const key = `${dir}||${base}`;
  if (!groups.has(key)) groups.set(key, { dir, base, items: [] });
  let st = null; try { st = fs.statSync(f); } catch {}
  groups.get(key).items.push({ path: f, mtime: st?.mtimeMs ?? 0, size: st?.size ?? 0 });
}

const toArchive = [];
let keepCount = 0;
for (const { dir, base, items } of groups.values()) {
  items.sort((a, b) => b.mtime - a.mtime);   // 最新在前
  keepCount += Math.min(items.length, KEEP);
  for (const it of items.slice(KEEP)) toArchive.push({ ...it, dir, base });
}

console.log(`扫描到 ${files.length} 个备份文件，分属 ${groups.size} 个目标`);
console.log(`保留最近 ${KEEP} 份：${keepCount} 个`);
console.log(`待归档：${toArchive.length} 个\n`);

if (!toArchive.length) { console.log('无需归档。'); process.exit(0); }

let bytes = 0;
for (const it of toArchive) bytes += it.size;

if (DRY) {
  for (const it of toArchive) {
    console.log(`  [dry] ${rel(it.path)}`);
  }
  console.log(`\n共 ${(bytes / 1024 / 1024).toFixed(1)} MB。加参数去掉 --dry-run 执行。`);
  process.exit(0);
}

let moved = 0, failed = 0;
for (const it of toArchive) {
  const relDir = path.relative(ROOT, it.dir);
  const destDir = path.join(ARCHIVE, relDir);
  const dest = path.join(destDir, path.basename(it.path));
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.renameSync(it.path, dest);
    moved++;
  } catch (e) {
    // 跨盘或占用时退回复制+删除
    try {
      fs.copyFileSync(it.path, dest);
      fs.unlinkSync(it.path);
      moved++;
    } catch (e2) {
      console.log(`  失败 ${rel(it.path)}: ${e2.message}`);
      failed++;
    }
  }
}

console.log(`\n已归档 ${moved} 个（${(bytes / 1024 / 1024).toFixed(1)} MB）→ ${rel(ARCHIVE)}`);
if (failed) console.log(`失败 ${failed} 个`);
