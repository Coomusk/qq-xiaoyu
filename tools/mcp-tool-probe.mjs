// 探针：用一个全新进程拉起 MCP 服务端，走标准握手后 tools/list，报告工具数与是否含指定工具。
// 为什么需要它：mcp-snowluma-safe.js 是在**进程启动时**按 config 决定注册哪些工具的
// （注册期过滤，见该文件 350-360 行），所以只看 config 或面板显示的开关，推不出「她到底能不能调」。
// 用法：node tools/mcp-tool-probe.mjs [工具名]
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const want = process.argv[2] || 'qq_list_stickers';

const p = spawn(process.execPath, [path.join(root, 'src', 'mcp-snowluma-safe.js')], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
p.stdout.on('data', (d) => { buf += d.toString(); });
p.stderr.on('data', () => {});
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const parseAll = () => buf.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } });
await wait(1500);
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
await wait(300);
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
await wait(2500);

const tl = parseAll().find((m) => m.id === 2);
const names = (tl?.result?.tools || []).map((t) => t.name);
console.log(`工具总数：${names.length}`);
console.log(`含 ${want}：${names.includes(want) ? '是' : '否'}`);
console.log(`表情类：${names.filter((n) => /sticker/i.test(n)).join(', ') || '（无）'}`);
p.kill();
