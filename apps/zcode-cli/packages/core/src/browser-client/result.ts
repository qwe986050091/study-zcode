import type {
  BrowserCommand,
  BrowserCommandResult,
} from "@zcode/contracts/browser-control";

// 浏览器命令失败的结构化错误：同时保留命令、原始返回体和归一化错误码，
// 让调用方能按 code 判类而不依赖 message 文本。
export class BrowserCommandError extends Error {
  // 稳定错误码：取 result.error.code，缺失时回退到调用方给定的 fallbackCode。
  readonly code: string;
  // 触发失败的原始 BrowserCommand，用于日志关联与问题复现。
  readonly command: BrowserCommand;
  // 原始命令返回体（ok=false 或缺少 payload），诊断信息不做二次加工。
  readonly result: BrowserCommandResult;

  // 从 result.error 提取 message/code 构造 Error；两者都缺失时用 code 生成兜底文案。
  // 不修改传入的 result，只按引用保存，读侧可拿到完整上下文。
  constructor(command: BrowserCommand, result: BrowserCommandResult, fallbackCode: string) {
    const code = result.error?.code ?? fallbackCode;
    super(result.error?.message ?? `Browser command failed: ${code}`);
    this.name = "BrowserCommandError";
    this.code = code;
    this.command = command;
    this.result = result;
  }
}

// 把传输层 base64 图片解码成新分配的 Uint8Array。
// 空串返回空数组；非法字符由 Buffer 静默丢弃，不抛错，故不会破坏上层流程。
export function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

// 断言命令返回 ok=true；失败时抛 BrowserCommandError（code 默认 browser_command_failed）。
// 成功时原样返回 result，不做字段拷贝，调用方可继续读取 value/image 等载荷。
// 这是纯校验，无 IO、无日志副作用；错误只向上抛给工具执行层。
export function expectOk(
  command: BrowserCommand,
  result: BrowserCommandResult,
): BrowserCommandResult {
  if (!result.ok) {
    throw new BrowserCommandError(command, result, "browser_command_failed");
  }
  return result;
}

// 在 expectOk 基础上校验载荷存在性：value 为 undefined 时抛 execution_error，
// 并把 payloadName 写进错误文案，便于区分"命令失败"与"命令成功但缺字段"。
// null 视为合法值不拦截；只拦截 undefined，保持与可选字段语义一致。
// 返回非 undefined 的 value，调用方无需再做空值判断。
export function expectPayload<T>(
  command: BrowserCommand,
  result: BrowserCommandResult,
  value: T | undefined,
  payloadName: string,
): T {
  expectOk(command, result);
  if (value === undefined) {
    throw new BrowserCommandError(
      command,
      {
        ...result,
        ok: false,
        error: { code: "execution_error", message: `Browser result missing ${payloadName}` },
      },
      "execution_error",
    );
  }
  return value;
}
