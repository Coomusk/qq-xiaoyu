// 只回滚「临时高频窗口」动过的那几组键，其余 config.json 内容原样保留。
// 用法：
//   node tools/restore-normal-freq.mjs --dry-run   只看会改什么，不写文件
//   node tools/restore-normal-freq.mjs             实际写回
// 数据来源：state/backup-config-tempfreq.json（临时窗口开始前的快照）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const BACKUP = path.join(ROOT, 'state', 'backup-config-tempfreq.json');
const DRY = process.argv.includes('--dry-run');

const cur = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const bak = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
const s = cur.socialV2;
const b = bak.socialV2;
const changes = [];

function setKey(label, target, key, value) {
  const before = target[key];
  if (JSON.stringify(before) === JSON.stringify(value)) return;
  changes.push({ label, before, after: value });
  if (!DRY) target[key] = value;
}

// 1) 两个群的覆盖对象整块替换（这两个对象里只装临时窗口的值：频率/发送上限/minProbability/临时 hint/batchWindowMs）
s.groupOverrides = s.groupOverrides && typeof s.groupOverrides === 'object' ? s.groupOverrides : {};
// 回滚备份里出现过的全部分群覆盖项（不写死具体群号）
const overrideIds = [...new Set([...Object.keys(s.groupOverrides || {}), ...Object.keys(b.groupOverrides || {})])];
for (const id of overrideIds) {
  const before = s.groupOverrides[id];
  const after = b.groupOverrides?.[id] ?? null;
  if (JSON.stringify(before) === JSON.stringify(after)) continue;
  changes.push({ label: `groupOverrides["${id}"]`, before, after });
  if (!DRY) {
    if (after === null) delete s.groupOverrides[id];
    else s.groupOverrides[id] = after;
  }
}

// 2) 唤醒批处理窗口 / 睡前观察闸门
setKey('wake.batchWindowMs', s.wake, 'batchWindowMs', b.wake?.batchWindowMs);
setKey('wake.preSleepWaitEnabled', s.wake, 'preSleepWaitEnabled', b.wake?.preSleepWaitEnabled);
setKey('wake.preSleepWaitMs', s.wake, 'preSleepWaitMs', b.wake?.preSleepWaitMs);

// 3) 等待工具开关
setKey('tools.waitMessages', s.tools, 'waitMessages', b.tools?.waitMessages);

// 4) 条间隔 / 连发间隔 / 长间隔
for (const k of ['gapBaseMs', 'gapPerCharMs', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
  setKey(`send.${k}`, s.send, k, b.send?.[k]);
}

// 打印（同时写到 stdout，供计划任务的日志收集）
const header = DRY ? '=== 预演（未写文件）===' : '=== 实际写回 ===';
console.log(header);
if (!changes.length) {
  console.log('没有需要改的键，config 已经是正常值');
} else {
  for (const c of changes) {
    console.log(`- ${c.label}`);
    console.log(`    旧: ${JSON.stringify(c.before)}`);
    console.log(`    新: ${JSON.stringify(c.after)}`);
  }
  console.log(`共 ${changes.length} 项`);
}

if (!DRY) {
  fs.writeFileSync(CONFIG, JSON.stringify(cur, null, 2), 'utf8');
  console.log('已写入 config.json');
}
