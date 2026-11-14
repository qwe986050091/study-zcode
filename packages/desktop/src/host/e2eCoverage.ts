// Host 进程 E2E 覆盖率落盘。
//
// 职责：在 Host 退出阶段主动调用 v8.takeCoverage()，把本 isolate 的覆盖率计数器写入
// NODE_V8_COVERAGE 目录；Host 由 main 调度退出，异常/强制回收时 Node 不会自动写盘。
// 输入输出：flushHostE2ECoverage(onError?) 返回 boolean，表示是否真正执行了 flush。
// 副作用：mkdirSync 创建覆盖率目录、takeCoverage 写文件。
// 失败语义：环境变量未开启（ZCODE_E2E_COVERAGE !== "1" 或无 NODE_V8_COVERAGE）返回 false
// 且不做任何事；写盘异常交给 onError 并返回 false，不向上抛出（退出路径不能失败）。

import { mkdirSync } from "node:fs";
import { takeCoverage } from "node:v8";

// 主动 flush 覆盖率；返回 true 仅代表 takeCoverage 调用成功，不代表文件一定已落盘。
// 必须在资源释放完成后调用，否则可能记录到已关闭模块的 counter 或漏掉后续执行。
// 失败语义：onError 回调可选；本函数始终返回 boolean，不抛出。
export function flushHostE2ECoverage(onError?: (error: unknown) => void): boolean {
  if (process.env.ZCODE_E2E_COVERAGE !== "1" || !process.env.NODE_V8_COVERAGE?.trim()) {
    return false;
  }
  try {
    mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });
    // host 的退出由 main 调度，异常或强制回收时不保证 Node 自动写盘；
    // 在资源释放完成后主动 flush，确保本进程 isolate 的 V8 counter 落盘。
    takeCoverage();
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  }
}
