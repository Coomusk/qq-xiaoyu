// 读取 DSH 会话记录（zstd 多帧），打印最近 N 次唤醒提示的长度、分段构成和关键标记。
// 用途：改唤醒提示后核对「某段还在不在 / 有没有变短」，不需要发 QQ 测试消息。
// 用法：node tools/wake-prompt-report.mjs [会话ID] [条数]
//   会话ID 省略时自动取 state/sessions.json 里第一个群的会话。
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sessionsFile = path.join(root, 'state', 'sessions.json');
// DSH 会话目录名由工作区绝对路径编码而来（`D:\a\b` → `--D-a-b--`）；
// 也可用 DSH_SESSIONS_DIR 直接指定，避免编码规则变化后找不到。
const agentsDir = path.join(root, 'state', 'agents');
const storeRoot = process.env.DSH_SESSIONS_DIR
  ? path.resolve(process.env.DSH_SESSIONS_DIR)
  : path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions',
    '--' + agentsDir.replace(/[\\/:]/g, (ch) => (ch === '\\' ? '-' : '')) + '--');

function pickSessionId() {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    const map = raw.sessions || raw;
    const first = Object.values(map).find((v) => typeof v === 'string' && v.startsWith('session-'));
    if (first) return first.slice('session-'.length);
  } catch { /* 落到参数或报错 */ }
  return '';
}

// 会话文件是多个 zstd 帧首尾相接：Node 的 zstdDecompressSync 只解第一帧，
// 所以按帧头魔数切开逐帧解压，拼回完整 jsonl。
function readTranscript(sessionId) {
  const file = path.join(storeRoot, `session-${sessionId}`, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(file)) throw new Error(`找不到会话文件：${file}`);
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offsets = [];
  for (let i = buf.indexOf(magic, 0); i !== -1; i = buf.indexOf(magic, i + 4)) offsets.push(i);
  const chunks = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], end)).toString('utf8')); } catch { /* 跨帧残片 */ }
  }
  return chunks.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const sessionId = process.argv[2] || pickSessionId();
const limit = Math.max(1, Math.min(10, Number(process.argv[3]) || 3));
if (!sessionId) { console.error('没有找到会话 ID，请显式传：node tools/wake-prompt-report.mjs <会话ID>'); process.exit(1); }

const recs = readTranscript(sessionId);
const wakes = recs.filter((r) => r.type === 'user/message'
  && (r.data?.content || []).some((c) => typeof c.text === 'string' && /【(唤醒|回复检查|主动机会|引导唤醒)】/.test(c.text)));

// 关键标记：黑话表 / 表情包策略 / 沉睡前观察 / 新旧分段标题
const MARKERS = ['【群聊黑话表】', '【表情包策略', '【可用表情包】', '沉睡前观察', '（自动学习，未审）',
  '【当前角色】', '【你的身份】', '【身份】', '【行动前】', '【怎么处理这轮】', '【本群的本子】', '【我主人和我待的场子】', '【时间感', '【你的样子】'];

// 提示词的一级段标题。人格卡内部也有【】小节（【你这个人】【怎么说话】…），
// 按 \n(?=【) 硬切会把卡拆成十几段、第一段只有几十字，看着像「卡没投进去」——2026-10-31 差点误报。
// 所以：从【你的样子】开始，往后吃掉所有「标题不在一级段名单里」的段，合成一段再统计。
const TOP_LEVEL = new Set(['【当前时间】', '【身份】', '【你的样子】', '【会话令牌】', '【当前角色】', '【你的身份】',
  '【说话基调】', '【回话与等待】', '【此刻状态】', '【我主人和我待的场子】', '【本群的本子】', '【全局本】',
  '【参与度参考】', '【时间感】', '【唤醒】', '【回复检查】', '【主动机会】', '【引导唤醒】', '【怎么处理这轮】',
  '【引用：只在必要时用】', '【本次消息快照】', '【行动前】', '【表情包策略', '【可用表情包】', '【群聊黑话表】']);

function mergeRoleCard(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const head = (parts[i].split('\n')[0] || '').slice(0, 40);
    if (head.startsWith('【你的样子】')) {
      let merged = parts[i];
      let j = i + 1;
      while (j < parts.length) {
        const nextHead = (parts[j].split('\n')[0] || '').slice(0, 40);
        if ([...TOP_LEVEL].some((t) => nextHead.startsWith(t)) && !nextHead.startsWith('【你的样子】')) break;
        merged += `\n${parts[j]}`;
        j += 1;
      }
      const sections = (merged.match(/\n【/g) || []).length + 1;
      out.push({ text: merged, label: `【你的样子】（人格卡，含 ${sections} 小节）` });
      i = j - 1;
    } else {
      out.push({ text: parts[i], label: (parts[i].split('\n')[0] || '').slice(0, 28) });
    }
  }
  return out;
}

console.log(`会话 ${sessionId}：共 ${wakes.length} 次唤醒提示`);
for (const r of wakes.slice(-limit)) {
  const text = (r.data.content || []).map((c) => c.text || '').join('');
  console.log(`\n==== ${new Date(r.time).toLocaleString('zh-CN')}  总长 ${text.length} 字符`);
  const cardSeg = mergeRoleCard(text.split(/\n(?=【)/)).find((s) => s.label.startsWith('【你的样子】'));
  for (const part of mergeRoleCard(text.split(/\n(?=【)/))) {
    console.log(`  ${String(part.text.length).padStart(5)}  ${part.label}`);
  }
  console.log(cardSeg ? `  人格卡合计 ${cardSeg.text.length} 字` : '  人格卡：本次无');
  console.log(`  标记：${MARKERS.filter((m) => text.includes(m)).join(' ') || '（无）'}`);
}
