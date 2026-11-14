// INV-01 空参数默认查询状态：守住位置 裁剪后判断；改错故障 空命令意外启动任务。
// INV-02 取消与停止同义归一：守住位置 动作判断；改错故障 两种写法行为不一致。
// INV-03 未知首词整体作为任务：守住位置 兜底返回；改错故障 多词任务只取首词。
// INV-04 运行标识空串转缺省：守住位置 或运算；改错故障 空标识被当作合法运行号。
// INV-05 能力缺失返回提示而非抛错：守住位置 能力判断；改错故障 老客户端整条命令失败。
// INV-06 各动作先校验能力再调用：守住位置 分支顺序；改错故障 调用未定义方法崩溃。
// INV-07 启动与恢复自动切到自主模式：守住位置 模式判断；改错故障 专家流程逐步等审批。
// INV-08 已处于目标模式不重复切换：守住位置 不等比较；改错故障 每次调用都写模式配置。
// INV-09 中止信号透传给能力实现：守住位置 参数对象；改错故障 用户取消后任务继续跑。
// INV-10 事件回调透传给启动与恢复：守住位置 参数对象；改错故障 界面收不到执行进度。
// INV-11 追踪标识优先取结果：守住位置 空值合并；改错故障 多任务日志串到同一标识。
// INV-12 回退到应用级追踪标识：守住位置 兜底取值；改错故障 结果缺标识时日志断链。
// INV-13 返回模式由依赖提供：守住位置 可选调用；改错故障 未注入时返回错误模式。
// INV-14 查询与停止携带可选运行号：守住位置 字段传递；改错故障 停止错任务。
// INV-15 恢复同样携带运行号：守住位置 字段传递；改错故障 恢复最近一次而非指定任务。
// INV-16 首词按空白切分：守住位置 搜索位置；改错故障 制表符分隔参数无法识别。
// INV-17 动作名转小写比较：守住位置 归一调用；改错故障 大写输入被判为任务文本。
// INV-18 任务文本保留原始内容：守住位置 裁剪范围；改错故障 任务丢失换行结构。
//
// 模块职责：命令行专家工作流的参数解析与动作派发。
// 状态所有权：无状态；依赖与应用能力都由调用方注入。
// 阅读顺序：先看动作分支，再看模式切换，最后看参数解析。
import type { TuiSubmitPromptResult } from "@zcode/tui";
import type { CommandCenterDeps, TuiSubmitOptions } from "../types.js";

// /expert 参数解析结果：status/stop/resume 可带可选 runId（空串转 undefined）；
// start 携带完整任务文本（首词不是已知动作时全部视为任务）。
type ParsedExpertCommand =
  | {
      action: "resume" | "status" | "stop";
      runId?: string;
    }
  | {
      action: "start";
      task: string;
    };

// 处理 /expert：status/stop/resume/start 四种动作，均通过 app 暴露的专家工作流能力执行。
// 客户端不支持对应能力时返回提示文本；resume/start 在非 guarded 模式下自动切到 yolo，
// 因为专家工作流需要自主执行且不逐次审批。traceId 优先取结果，缺省回退 app.traceId。
// 先 await deps.getApp() 取应用，再 parseExpertCommandArgs 解析动作。
// 四个分支各自检查 app 上对应能力，缺失时统一返回同一句不可用提示。
// resume 与 start 在 mode 不是 guarded 时 await deps.setMode("yolo")。
// 四个分支的 traceId 都取 result.traceId，缺省才回退 app.traceId。
export async function handleExpertCommand(
  args: string,
  deps: CommandCenterDeps,
  options: TuiSubmitOptions,
): Promise<TuiSubmitPromptResult> {
  const app = await deps.getApp();
  const parsed = parseExpertCommandArgs(args);

  if (parsed.action === "status") {
    if (!app.expertWorkflowStatus) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    const result = await app.expertWorkflowStatus({
      abortSignal: options.abortSignal,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (parsed.action === "stop") {
    if (!app.stopExpertWorkflow) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    const result = await app.stopExpertWorkflow({
      abortSignal: options.abortSignal,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (parsed.action === "resume") {
    if (!app.resumeExpertWorkflow) {
      return {
        mode: deps.getMode?.(),
        response: "Expert workflow is not available in this client.",
      };
    }
    if (deps.setMode && (deps.getMode?.() ?? app.getMode?.()) !== "guarded") {
      await deps.setMode("yolo");
    }
    const result = await app.resumeExpertWorkflow({
      abortSignal: options.abortSignal,
      onEvent: options.onEvent,
      runId: parsed.runId,
    });
    return {
      mode: deps.getMode?.(),
      response: result.response,
      traceId: result.traceId ?? app.traceId,
    };
  }

  if (!app.runExpertWorkflow) {
    return {
      mode: deps.getMode?.(),
      response: "Expert workflow is not available in this client.",
    };
  }
  if (deps.setMode && (deps.getMode?.() ?? app.getMode?.()) !== "guarded") {
    await deps.setMode("yolo");
  }
  const task = parsed.action === "start" ? parsed.task : "";
  const result = await app.runExpertWorkflow(
    {
      task,
    },
    {
      abortSignal: options.abortSignal,
      onEvent: options.onEvent,
    },
  );
  return {
    mode: deps.getMode?.(),
    response: result.response,
    traceId: result.traceId ?? app.traceId,
  };
}

// 解析 /expert 参数：空参数默认 status；"cancel" 归一为 stop（同义动作）；
// 首词非已知动作时整体作为 start 的任务文本，保留原始空白后的内容。
// args.trim() 为空串时直接返回 { action: "status" }。
// 用 trimmed.search(/\s/) 找首个空白，切出 first 与 rest。
// action 不在 status/resume/stop/cancel 内时返回 { action: "start", task: trimmed }。
function parseExpertCommandArgs(args: string): ParsedExpertCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0) {
    return { action: "status" };
  }

  const firstWhitespace = trimmed.search(/\s/);
  const first = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
  const rest = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace + 1).trim();
  const action = first.toLowerCase();

  if (action === "status" || action === "resume") {
    return {
      action,
      runId: rest || undefined,
    };
  }
  // action 为 "cancel" 时与 "stop" 同路，统一返回 action: "stop"。
  // rest 为空串时 runId 传 undefined，交给下游取默认运行。
  // 走到函数末尾即未知首词，整串 trimmed 作为 task。
  if (action === "stop" || action === "cancel") {
    return {
      action: "stop",
      runId: rest || undefined,
    };
  }

  return {
    action: "start",
    task: trimmed,
  };
}
