// B45 insert: mcp-stdio/get-environment.ts + mcp-stdio/create-child-process.ts
import fs from 'node:fs';

const ROOT = 'D:/code/opensource/ai/packages/mcp/src/tool/mcp-stdio/';
const files = [
  {
    name: 'get-environment.ts',
    want: [6, 8],
    blocks: [
      { at: 7, expect: 'export function getEnvironment(', lines: [
        '// 合并自定义环境变量与平台默认白名单。',
        '// 只继承一组有限的系统变量，避免把全部环境泄漏给子进程。',
        '// 返回值可直接用于 spawn 的 env 选项。',
      ] },
      { at: 10, expect: "const isWindows = globalThis.process.platform === 'win32';", lines: [
        '// Windows 与 POSIX 的必需变量不同。',
        '// Windows 需要系统盘、用户目录与架构等变量才能正常启动。',
      ] },
      { at: 32, expect: 'for (const key of DEFAULT_INHERITED_ENV_VARS) {', lines: [
        '// 逐项继承：自定义值优先，缺失或可疑值跳过。',
      ] },
    ],
  },
  {
    name: 'create-child-process.ts',
    want: [9, 9],
    blocks: [
      { at: 1, expect: "import type { ChildProcess } from 'node:child_process';", lines: [
        '// ============================================================================',
        '// create-child-process：为 stdio 传输创建子进程',
        '// 统一处理环境变量、标准流与 Windows 下的特殊约束。',
        '// 返回值即传输层后续读写的子进程句柄。',
      ] },
      { at: 6, expect: 'export function createChildProcess(', lines: [
        '// 按配置启动子进程；信号用于关闭时中止。',
      ] },
      { at: 10, expect: 'if (', lines: [
        '// Windows 下命令行中的换行可能被解释为多条命令，必须拒绝。',
      ] },
      { at: 19, expect: 'return spawn(config.command, config.args ?? [], {', lines: [
        '// stdin/stdout 走管道用于收发消息，stderr 默认继承父进程。',
        '// windowsHide 在 Electron 下避免弹出控制台窗口。',
      ] },
      { at: 29, expect: 'function isElectron() {', lines: [
        '// Electron 运行时会在 process 上暴露 type 字段。',
      ] },
    ],
  },
];

let grand = 0;
for (const f of files) {
  const path = ROOT + f.name;
  const raw = fs.readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(eol);
  let total = 0;
  let bad = 0;
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`MISMATCH ${f.name}:${b.at} expected [${b.expect}] actual [${actual}]`);
      bad++;
    }
    total += b.lines.length;
  }
  if (bad) process.exit(1);
  if (process.env.DRY) {
    console.log('DRY', f.name, total);
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`COUNT ${f.name}=${total} want ${f.want[0]}..${f.want[1]}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  console.log('ADDED', f.name, total);
  grand += total;
}
console.log('TOTAL', grand);
