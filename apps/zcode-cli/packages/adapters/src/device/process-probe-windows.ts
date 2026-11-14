// ============================================================
// 文件定位：Windows 进程内存采样，唯一外部命令是 tasklist（一次调用覆盖全部进程）。
// 输入输出：输入待采样 pid 集合，输出这些 pid 的 RSS 样本；查不到的 pid 直接缺席。
// 副作用：每次调用 spawn 一次 tasklist（windowsHide、1s 超时、8MB 缓冲）。
// 失败语义：tasklist 失败向上抛 ProcessProbeFailure；单行解析失败只跳过该行。
// 不变量：不调用任何重脚本宿主；tasklist 无 ppid/cpu 时间，样本不含这两个字段。
// ============================================================
import {
  runProbeCommand,
  type ProcessProbeExecFile,
  type ProcessProbeSample,
} from "./process-probe-shared.js";

/**
 * Windows：唯一允许的外部进程是 `tasklist`，一次调用拿全部进程内存。
 * 严禁改用 Windows 管理接口脚本宿主一类实现（见 spec 性能红线的禁用关键字清单）：
 * 历史事故就是那样每隔几秒起一个重进程，显著拖慢用户电脑。
 * tasklist 既没有 ppid 也没有累计 CPU 时间，因此这里只回直连进程的 RSS。
 */
export async function readWindowsProcessMemory(
  execFile: ProcessProbeExecFile,
  pids: readonly number[],
): Promise<readonly ProcessProbeSample[]> {
  const stdout = await runProbeCommand(execFile, "tasklist", ["/FO", "CSV", "/NH"], {
    windowsHide: true,
  });
  // CSV 只解析关心的 pid，避免把上百行无关进程都转成样本对象。
  const wanted = new Set(pids);
  const samples: ProcessProbeSample[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const fields = parseCsvFields(line);
    const pid = Number(fields[1]);
    if (!wanted.has(pid)) continue;
    // 内存列形如 "12,345 K"：去掉分隔符与单位后只保留数字；非数字视为解析失败并跳过。
    const memoryDigits = (fields[4] ?? "").replace(/\D/g, "");
    if (!memoryDigits) continue;
    const rssKb = Number(memoryDigits);
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    samples.push({ pid, rssKb });
  }
  return samples;
}

/**
 * 解析 tasklist `/FO CSV` 的一行：只取被双引号包裹的字段。
 * 引号内的 `""` 是转义引号，需还原成 `"`；不含引号的行返回空数组，由调用方按陪伴跳过。
 */
function parseCsvFields(line: string): string[] {
  const fields: string[] = [];
  for (const match of line.matchAll(/"((?:[^"]|"")*)"/g)) {
    fields.push((match[1] ?? "").replace(/""/g, '"'));
  }
  return fields;
}
