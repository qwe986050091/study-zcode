/**
 * 子进程执行封装：统一管理 adb/emulator/gradle 等外部命令的启动、超时、stdin 输入与输出收集。
 *
 * 职责边界：只负责「跑命令并把结果结构化返回」，不判断业务成功、不做重试、不解析业务输出。
 * 输入输出：输入为参数数组（不经过 shell 拼接），输出 Run 结构含 cmd/code/stdout/stderr/timed。
 * 副作用：真实启动子进程，可能修改外部系统状态（安装应用、启动模拟器等）。
 * 失败语义：命令不存在或启动失败不抛错，而是返回 code=127 并把原因放进 stderr；
 * 超时后发 SIGTERM 并置 timed=true，由调用方通过 ok() 判定失败。
 * 跨平台：Windows 下 .bat/.cmd 需要经 cmd.exe /c 执行并做参数转义，其余平台直接 spawn。
 * 不变式：close/error 只结算一次退出码，避免超时与正常退出竞争导致重复 resolve。
 */
import { spawn as spawnChild, type ChildProcess } from "node:child_process";

/**
 * 一次外部命令的执行结果快照。
 * cmd 为原始参数数组（便于回显）；code 为退出码（启动失败固定 127）；
 * stdout/stderr 为完整收集的 UTF-8 文本；timed 表示是否因超时被 SIGTERM。
 * 调用方应同时看 code 与 timed，不能只看 code 判断成功。
 */
export type Run = {
  cmd: string[];
  code: number;
  stdout: string;
  stderr: string;
  timed: boolean;
};

/**
 * run() 的可选参数。
 * cwd 指定工作目录（如 gradle 需在项目根执行）；env 覆盖继承的环境变量；
 * input 非 undefined 时启用 stdin 管道并写入该文本；timeout 单位毫秒，默认 120 秒。
 */
type RunOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string;
  timeout?: number;
};

/**
 * 执行一条外部命令并收集结果，永不因命令失败而 reject。
 *
 * 输入 cmd 为 argv 数组，首元素是可执行文件；opts 控制 cwd、env 覆盖、stdin 与超时。
 * 输出 Run：正常结束返回真实退出码，启动失败返回 127，超时返回已收到的部分输出且 timed=true。
 * 副作用：启动子进程、可能写 stdin、超时后发送 SIGTERM；不写日志。
 * 失败语义：错误统一折叠进返回值，调用方用 ok()/brief() 决定如何呈现，避免异常穿透工具层。
 * 注意：env 会先合并 process.env，再过滤掉 undefined，防止子进程收到非法环境值。
 */
export async function run(cmd: string[], opts: RunOpts = {}): Promise<Run> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter(
      (item): item is [string, string] => {
        return typeof item[1] === "string";
      },
    ),
  );
  const actual = commandForPlatform(cmd);
  const child = spawn(actual, opts.cwd, env, opts.input !== undefined);
  // 启动失败（命令不存在、权限不足）不抛异常，降级为 127 结果，让工具层返回可读错误。
  if (child instanceof Error) {
    return {
      cmd,
      code: 127,
      stdout: "",
      stderr: child.message,
      timed: false,
    };
  }
  const timeout = opts.timeout ?? 120_000;
  let timed = false;
  let spawnError: Error | undefined;
  // 超时只发 SIGTERM 并打标记，不在此处结算；真正的退出码仍由 close/error 事件决定，
  // 这样能保留被杀进程已输出的内容，避免长命令日志全部丢失。
  const timer = setTimeout(() => {
    timed = true;
    child.kill("SIGTERM");
  }, timeout);
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  if (opts.input !== undefined && child.stdin) {
    child.stdin.write(opts.input);
    child.stdin.end();
  }
  const code = await new Promise<number>((resolve) => {
    let settled = false;
    // settled 保证 error 与 close 竞争时只结算一次，避免 Promise 重复 resolve 且定时器泄漏。
    const settle = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode);
    };

    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
      settle(127);
    });
    // close 事件可能拿到 null（被信号杀死），统一映射为 1，保证 code 始终是数字。
    child.once("close", (exitCode) => settle(exitCode ?? 1));
  });
  const stdout = await out;
  const stderr = await err;
  return {
    cmd,
    code,
    stdout,
    // 运行期 error 事件（如 ENOENT 在异步阶段抛出）没有 stderr，这里把系统错误信息拼进去，
    // 否则调用方只能看到空 stderr 而无法定位失败原因。
    stderr: spawnError ? [stderr.trim(), spawnError.message].filter(Boolean).join("\n") : stderr,
    timed,
  };
}

/**
 * 实际拉起子进程，把同步抛出的异常转成返回值。
 *
 * shell 固定为 false，依赖 argv 传参避免命令注入与 POSIX 语法差异；
 * stdin 仅在需要写入时开管道，否则 ignore，防止子进程等待输入而挂死。
 * 同步抛错（如非法参数、EMFILE）不向上抛，而是返回 Error 交给 run() 降级为 127。
 */
function spawn(
  cmd: string[],
  cwd: string | undefined,
  env: Record<string, string>,
  pipeStdin: boolean,
): ChildProcess | Error {
  const [command, ...args] = cmd;
  if (!command) return new Error("Missing command");
  try {
    return spawnChild(command, args, {
      cwd,
      env,
      shell: false,
      stdio: [pipeStdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * 流式收集子进程输出直到 EOF，按 utf8 解码。
 *
 * 用 Buffer.concat 而不是字符串逐块拼接，避免多字节 UTF-8 字符被 chunk 边界截断成乱码。
 * stream 为空（stdio 为 ignore）时返回空串；读取错误会向上抛，由 run() 的 Promise 链传递。
 */
async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Windows 兼容层：把 .bat/.cmd 包装成 cmd.exe /d /s /c 命令行。
 *
 * 非 Windows 或非批处理文件原样返回，不影响其它平台行为。
 * 只有批处理必须经 cmd.exe 解释，否则 spawn 无法直接执行；/d 关闭 AutoRun、/s 保留引号语义，
 * 参数统一经 cmdQuote 转义，避免空格与元字符（& | ^ 等）被 shell 误解析。
 */
function commandForPlatform(cmd: string[]): string[] {
  const head = cmd[0];
  if (process.platform !== "win32" || !head || !/\.(bat|cmd)$/i.test(head)) return cmd;
  return ["cmd.exe", "/d", "/s", "/c", cmd.map(cmdQuote).join(" ")];
}

/**
 * 为 cmd.exe 转义单个参数。
 *
 * 不含空白与元字符时直接返回，尽量减少无谓引号；需要时用双引号包裹并把内部 " 与 ^ 转义为 ^x，
 * 这是 cmd.exe 的转义规则，Windows 路径中常见空格目录（Program Files）依赖此逻辑。
 */
function cmdQuote(value: string): string {
  if (!/[ \t&()^|<>"]/.test(value)) return value;
  return `"${value.replace(/(["^])/g, "^$1")}"`;
}

/**
 * 判断一次执行是否成功。
 *
 * 必须同时满足 code===0 且未超时：超时进程可能恰好以 0 退出（部分命令忽略 SIGTERM），
 * 只看 code 会把超时误判为成功，因此 timed 是独立的失败信号。
 */
export function ok(item: Run): boolean {
  return item.code === 0 && !item.timed;
}

/**
 * 生成给模型/用户看的命令输出摘要。
 *
 * 合并 stdout 与 stderr（空行过滤），超长时按 limit 截断并追加 [truncated] 标记，
 * 避免 gradle/adb 的大段日志撑爆上下文。截断只保留前段，因为错误通常出现在开头附近；
 * 调用方若需要完整日志应自行读取落盘文件。
 */
export function brief(item: Run, limit = 4000): string {
  const text = [item.stdout.trim(), item.stderr.trim()].filter(Boolean).join("\n");
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "\n...[truncated]";
}
