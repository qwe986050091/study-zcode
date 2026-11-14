/* ============================================================
 * Windows Job Object 托管（adapters/src/mcp/windows-job-object.ts）
 *
 * 定位：让 MCP stdio 子进程及其整棵后代在 Agent 退出/崩溃时被内核统一终止，
 * 弥补 Windows 无 POSIX 进程组、taskkill 可能漏掉已脱离父子关系的进程。
 * 输入：子进程 pid；输出：控制器（terminate/close）或 undefined（非 Windows/失败）。
 * 副作用：加载 koffi 原生模块、创建内核 Job Object、设置 KILL_ON_JOB_CLOSE。
 * 失败语义：模块缺失、API 不可用、Assign 失败一律返回 undefined 或空操作；调用方
 * 必须保留 taskkill 回退，绝不因托管失败而阻断 MCP 连接。
 * 不变量：一个控制器只对应一个 Job；close 幂等；子进程仍在 Job 内时关闭句柄
 * 即触发内核杀树，因此必须先 assign 成功再关闭/丢弃句柄。
 * ============================================================ */

import type * as Koffi from "koffi";

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;

type WindowsJobHandle = object;

/**
 * 已挂载的 Job Object 控制器。
 * pid：被托管的根进程；terminate() 终止整棵 job；close() 释放内核句柄（幂等）。
 * 两个方法都不承诺重试，失败由调用方按 best-effort 处理。
 */
export interface WindowsJobObjectController {
  terminate(): void;
  close(): void;
}

/**
 * 可注入的 Job Object 原生 API 薄封装。
 * create 返回内核句柄（失败 undefined）；assign 把 pid 加入 Job（成功 true）；
 * terminate 杀整棵 job；close 释放句柄并（因 KILL_ON_JOB_CLOSE）连带终止进程。
 */
export interface WindowsJobObjectApi {
  create(): WindowsJobHandle | undefined;
  assign(job: WindowsJobHandle, pid: number): boolean;
  terminate(job: WindowsJobHandle): void;
  close(job: WindowsJobHandle): void;
}

/** 注入点：api 用于测试/自定义实现，platform 默认当前平台（仅 win32 生效）。 */
interface AttachOptions {
  api?: WindowsJobObjectApi;
  platform?: NodeJS.Platform;
}

/**
 * 尝试把子进程挂到 kill-on-close 的 Job Object。
 *
 * 非 Windows / 非法 pid / 原生 API 不可用：返回 undefined，调用方继续用 taskkill。
 * create 或 assign 失败时尽力关闭已建句柄并返回 undefined，不抛错。
 * 成功后返回控制器；此后父进程崩溃也会由内核回收整棵 MCP 进程树。
 * 副作用：创建内核对象、打开并关闭进程句柄；无网络/文件 IO。
 */
export async function attachProcessToWindowsJobObject(
  pid: number,
  options: AttachOptions = {},
): Promise<WindowsJobObjectController | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;

  const api = options.api ?? (await loadWindowsJobObjectApi());
  if (!api) return undefined;

  let job: WindowsJobHandle | undefined;
  try {
    job = api.create();
    if (!job || !api.assign(job, pid)) {
      if (job) api.close(job);
      return undefined;
    }
  } catch {
    if (job) {
      try {
        api.close(job);
      } catch {
        // 原生句柄关闭失败也不能阻断既有 taskkill 回退。
      }
    }
    return undefined;
  }

  let closed = false;
  return {
    terminate() {
      if (!closed) api.terminate(job);
    },
    close() {
      if (closed) return;
      closed = true;
      api.close(job);
    },
  };
}

/** 进程级单例：首次成功/失败都缓存，避免每个 server 重复 import 原生模块。 */
let nativeApiPromise: Promise<WindowsJobObjectApi | undefined> | undefined;

/**
 * 惰性加载原生 API。
 * 失败结果同样缓存（undefined），防止高频重试拖慢 MCP 启动。
 */
async function loadWindowsJobObjectApi(): Promise<WindowsJobObjectApi | undefined> {
  nativeApiPromise ??= createWindowsJobObjectApi();
  return nativeApiPromise;
}

/**
 * 加载 koffi 并声明 CreateJobObject/SetInformationJobObject/OpenProcess/
 * AssignProcessToJobObject/TerminateJobObject/CloseHandle 及对应结构。
 *
 * create() 设置 KILL_ON_JOB_CLOSE；设置失败会立即 close 句柄并返回 undefined。
 * assign() 打开进程句柄后必须在 finally 关闭，避免句柄泄漏。
 * 任何加载/声明错误都吞掉并返回 undefined，保证其它平台与降级路径不受影响。
 */
async function createWindowsJobObjectApi(): Promise<WindowsJobObjectApi | undefined> {
  try {
    const koffiModule = await import("koffi");
    const koffi = ("default" in koffiModule ? koffiModule.default : koffiModule) as typeof Koffi;
    const kernel32 = koffi.load("kernel32.dll");
    const handleType = koffi.pointer("HANDLE", koffi.opaque());
    const basicLimitInformation = koffi.struct("JOBOBJECT_BASIC_LIMIT_INFORMATION", {
      PerProcessUserTimeLimit: "int64",
      PerJobUserTimeLimit: "int64",
      LimitFlags: "uint32",
      MinimumWorkingSetSize: "size_t",
      MaximumWorkingSetSize: "size_t",
      ActiveProcessLimit: "uint32",
      Affinity: "uintptr_t",
      PriorityClass: "uint32",
      SchedulingClass: "uint32",
    });
    const ioCounters = koffi.struct("IO_COUNTERS", {
      ReadOperationCount: "uint64",
      WriteOperationCount: "uint64",
      OtherOperationCount: "uint64",
      ReadTransferCount: "uint64",
      WriteTransferCount: "uint64",
      OtherTransferCount: "uint64",
    });
    const extendedLimitInformation = koffi.struct("JOBOBJECT_EXTENDED_LIMIT_INFORMATION", {
      BasicLimitInformation: basicLimitInformation,
      IoInfo: ioCounters,
      ProcessMemoryLimit: "size_t",
      JobMemoryLimit: "size_t",
      PeakProcessMemoryUsed: "size_t",
      PeakJobMemoryUsed: "size_t",
    });

    const createJobObject = kernel32.func("__stdcall", "CreateJobObjectW", handleType, [
      "void *",
      "str16",
    ]);
    const setInformationJobObject = kernel32.func(
      "__stdcall",
      "SetInformationJobObject",
      "bool",
      [handleType, "uint32", koffi.pointer(extendedLimitInformation), "uint32"],
    );
    const openProcess = kernel32.func("__stdcall", "OpenProcess", handleType, [
      "uint32",
      "bool",
      "uint32",
    ]);
    const assignProcessToJobObject = kernel32.func(
      "__stdcall",
      "AssignProcessToJobObject",
      "bool",
      [handleType, handleType],
    );
    const terminateJobObject = kernel32.func("__stdcall", "TerminateJobObject", "bool", [
      handleType,
      "uint32",
    ]);
    const closeHandle = kernel32.func("__stdcall", "CloseHandle", "bool", [handleType]);

    return {
      create() {
        const job = createJobObject(null, null) as WindowsJobHandle | null;
        if (!job) return undefined;
        const limits = {
          BasicLimitInformation: {
            PerProcessUserTimeLimit: 0,
            PerJobUserTimeLimit: 0,
            LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            MinimumWorkingSetSize: 0,
            MaximumWorkingSetSize: 0,
            ActiveProcessLimit: 0,
            Affinity: 0,
            PriorityClass: 0,
            SchedulingClass: 0,
          },
          IoInfo: {
            ReadOperationCount: 0,
            WriteOperationCount: 0,
            OtherOperationCount: 0,
            ReadTransferCount: 0,
            WriteTransferCount: 0,
            OtherTransferCount: 0,
          },
          ProcessMemoryLimit: 0,
          JobMemoryLimit: 0,
          PeakProcessMemoryUsed: 0,
          PeakJobMemoryUsed: 0,
        };
        if (
          !setInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            limits,
            koffi.sizeof(extendedLimitInformation),
          )
        ) {
          closeHandle(job);
          return undefined;
        }
        return job;
      },
      assign(job, pid) {
        const processHandle = openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) as
          | WindowsJobHandle
          | null;
        if (!processHandle) return false;
        try {
          return Boolean(assignProcessToJobObject(job, processHandle));
        } finally {
          closeHandle(processHandle);
        }
      },
      terminate(job) {
        terminateJobObject(job, 1);
      },
      close(job) {
        closeHandle(job);
      },
    } satisfies WindowsJobObjectApi;
  } catch {
    // 原生模块或 Windows API 不可用时保持既有 taskkill 回退，不影响其他平台。
    return undefined;
  }
}
