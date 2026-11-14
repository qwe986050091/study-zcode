import fs from 'node:fs';
const ROOT = 'D:/code/opensource/ai/packages/ai/src/';
const files = [
  {
    name: 'util/serial-job-executor.ts',
    want: [13, 13],
    blocks: [
      { at: 1, expect: "import type { Job } from './job';", lines: ['// 串行任务执行器使用的任务类型。'] },
      { at: 3, expect: 'export class SerialJobExecutor {', lines: ['// 串行执行队列：同一时刻只运行一个任务，其余排队。'] },
      { at: 4, expect: 'private queue: Array<Job> = [];', lines: ['// 待执行任务队列，按入队顺序消费。'] },
      { at: 5, expect: 'private isProcessing = false;', lines: ['// 是否已有任务在处理中，避免并发消费。'] },
      { at: 6, expect: 'private idleWaiters: Array<() => void> = [];', lines: ['// 空闲等待者集合，队列清空后统一唤醒。'] },
      { at: 8, expect: 'private async processQueue() {', lines: ['// 消费队列：循环取出任务执行，结束后唤醒等待者。'] },
      { at: 9, expect: 'if (this.isProcessing) {', lines: ['// 已有消费者时直接返回，保证串行。'] },
      { at: 13, expect: 'this.isProcessing = true;', lines: ['// 抢占处理标记。'] },
      { at: 15, expect: 'try {', lines: ['// 无论成功失败都要复位标记并唤醒等待者。'] },
      { at: 16, expect: 'while (this.queue.length > 0) {', lines: ['// 逐个执行队首任务，完成后出队。'] },
      { at: 20, expect: '} finally {', lines: ['// finally 保证异常时也能复位状态。'] },
      { at: 29, expect: 'async run(job: Job): Promise<void> {', lines: ['// 入队任务，返回的 Promise 在任务完成或失败时结算。'] },
      { at: 44, expect: 'async waitForIdle(): Promise<void> {', lines: ['// 等待队列清空且处理结束。'] },
    ],
  },
  {
    name: 'upload-skill/upload-skill.ts',
    want: [9, 9],
    blocks: [
      { at: 1, expect: 'import type {', lines: ['// 提供方能力与技能相关类型导入。'] },
      { at: 7, expect: "import type { UploadSkillResult } from './upload-skill-result';", lines: ['// 上传结果类型。'] },
      { at: 9, expect: "type UploadSkillFile = Omit<SkillsV4File, 'data'> & {", lines: ['// 上传文件入参：在技能文件基础上放宽 data 的写法。'] },
      { at: 17, expect: 'export async function uploadSkill({', lines: ['// 上传技能：兼容直接暴露 uploadSkill 或经由 skills() 的提供方。'] },
      { at: 23, expect: 'api: SkillsV4 | ProviderV4;', lines: ['// api 可以是技能接口，也可以是聚合提供方。'] },
      { at: 25, expect: 'files: UploadSkillFile[];', lines: ['// 文件数组为必填，其余调用选项透传。'] },
      { at: 27, expect: 'const skillsApi: SkillsV4 =', lines: ['// 解析技能接口：优先直连，其次通过 skills() 获取。'] },
      { at: 38, expect: 'const normalizedFiles: SkillsV4File[] = files.map(file => ({', lines: ['// 归一化文件数据：短写形式补全为带类型的 data。'] },
      { at: 46, expect: 'const result = await skillsApi.uploadSkill({', lines: ['// 调用底层上传接口并原样返回结果。'] },
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
  for (const b of f.blocks) {
    const actual = (lines[b.at - 1] ?? '').trim();
    if (actual !== b.expect) {
      console.error(`ANCHOR FAIL ${f.name} at=${b.at}\n  expect: ${b.expect}\n  actual: ${actual}`);
      process.exit(1);
    }
    total += b.lines.length;
  }
  console.log(`CHECK ${f.name} +${total}`);
  if (process.env.DRY) {
    grand += total;
    continue;
  }
  if (total < f.want[0] || total > f.want[1]) {
    console.error(`WANT FAIL ${f.name} total=${total} want=${f.want.join('~')}`);
    process.exit(1);
  }
  const sorted = [...f.blocks].sort((a, b) => b.at - a.at);
  for (const b of sorted) lines.splice(b.at - 1, 0, ...b.lines);
  fs.writeFileSync(path, lines.join(eol), 'utf8');
  grand += total;
}
console.log(`SUMMARY files=${files.length} added=${grand}`);
