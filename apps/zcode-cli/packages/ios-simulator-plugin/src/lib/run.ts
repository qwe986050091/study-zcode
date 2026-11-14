/**
 * 子进程执行封装：统一管理 xcrun/simctl/xcodebuild 等 macOS 外部命令的启动、超时与输出收集。
 *
 * 职责边界：只负责跑命令并结构化返回结果，不判断业务成功、不重试、不解析业务输出。
 * 输入输出：输入为 argv 数组（不经过 shell），输出 Run（cmd/code/stdout/stderr/timed）。
 * 副作用：真实启动子进程，可能修改外部状态（启动模拟器、构建 App）。
 * 失败语义：命令缺失或启动失败不抛错，返回 code=127 并将原因写入 stderr；超时发 SIGTERM 并置 timed=true。
 * 跨平台：本插件运行于 macOS，直接 spawn 可执行文件；Windows 的 .bat/cmd 包装逻辑不在本模块职责内。
 * 不变式：close/error 竞争时只结算一次退出码，避免 Promise 重复 resolve 与定时器泄漏。
 */
import { spawn as spawnChild, type ChildProcess } from "node:child_process"

/**
 * 一次外部命令的执行结果快照。
 * code 为退出码（启动失败固定 127）；stdout/stderr 为完整 UTF-8 文本；
 * timed 表示是否因超时被 SIGTERM。成功需同时满足 code=0 与 !timed。
 */
export type Run = {
  cmd: string[]
  code: number
  stdout: string
  stderr: string
  timed: boolean
}

/**
 * run() 的可选参数。cwd 指定工作目录（如 xcodebuild 需在工程根执行）；
 * env 覆盖继承的环境变量；timeout 单位为毫秒，默认 120 秒。
 * 本模块不提供 stdin 输入，需要交互命令的工具应另行实现，避免误以为能自动应答。
 */
type RunOpts = {
  cwd?: string
  env?: Record<string, string | undefined>
  timeout?: number
}

/**
 * 执行一条外部命令并收集结果，永不因命令失败而 reject。
 *
 * 输入 cmd 为 argv 数组，首元素为可执行文件；opts 控制 cwd、env 覆盖与超时。
 * 输出 Run：正常结束返回真实退出码，启动失败 127，超时返回已收集的部分输出且 timed=true。
 * 副作用：启动子进程、超时发送 SIGTERM；不写日志。
 * 失败语义：所有错误折叠进返回值，调用方用 ok()/brief() 决定呈现方式，避免异常穿透工具层。
 * 注意：env 先合并 process.env 再过滤 undefined，防止子进程收到非法环境值。
 */
export async function run(cmd: string[], opts: RunOpts = {}): Promise<Run> {
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter((item): item is [string, string] => {
      return typeof item[1] === "string"
    }),
  )
  const child = spawn(cmd, opts.cwd, env)
  // 启动失败（命令不存在、权限不足）降级为 127 结果，让工具层能返回可读错误而不是抛异常。
  if (child instanceof Error) {
    return {
      cmd,
      code: 127,
      stdout: "",
      stderr: child.message,
      timed: false,
    }
  }
  const timeout = opts.timeout ?? 120_000
  let timed = false
  let spawnError: Error | undefined
  // 超时只发 SIGTERM 并打标记，不在此处结算；退出码仍由 close/error 决定，
  // 以便保留被杀进程已输出的内容，长命令（如 xcodebuild）日志不至于全部丢失。
  const timer = setTimeout(() => {
    timed = true
    child.kill("SIGTERM")
  }, timeout)
  const out = collect(child.stdout)
  const err = collect(child.stderr)
  const code = await new Promise<number>((resolve) => {
    let settled = false
    // settled 保证 error 与 close 竞争时只结算一次，避免重复 resolve 和定时器泄漏。
    const settle = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(exitCode)
    }

    child.once("error", (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error))
      settle(127)
    })
    // close 可能拿到 null（被信号杀死），统一映射为 1，保证 code 始终是数字。
    child.once("close", (exitCode) => settle(exitCode ?? 1))
  })
  const stdout = await out
  const stderr = await err
  return {
    cmd,
    code,
    stdout,
    // 异步阶段抛出的 error（如 ENOENT）没有 stderr，需把系统错误拼进去，否则调用方看不到失败原因。
    stderr: spawnError ? [stderr.trim(), spawnError.message].filter(Boolean).join("\n") : stderr,
    timed,
  }
}

/**
 * 实际拉起子进程，把同步抛出的异常转成返回值。
 *
 * shell 固定为 false，依赖 argv 传参避免命令注入与 shell 语法差异；
 * stdio 为 ignore/pipe/pipe：不开放 stdin，防止子进程等待交互输入而挂死。
 * 同步抛错（非法参数、EMFILE）不向上抛，而是返回 Error 交给 run() 降级为 127。
 */
function spawn(cmd: string[], cwd: string | undefined, env: Record<string, string>): ChildProcess | Error {
  const [command, ...args] = cmd
  if (!command) return new Error("Missing command")
  try {
    return spawnChild(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

/**
 * 流式收集子进程输出直到 EOF，按 utf8 解码。
 * 用 Buffer.concat 而非字符串逐块拼接，避免多字节字符被 chunk 边界截断成乱码；
 * stream 为空（stdio=ignore）时返回空串。
 */
async function collect(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return ""
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks).toString("utf8")
}

/**
 * 判断一次执行是否成功。
 * 必须同时满足 code=0 与未超时：超时进程可能恰好以 0 退出（忽略 SIGTERM），只看 code 会误判成功。
 */
export function ok(item: Run): boolean {
  return item.code === 0 && !item.timed
}

/**
 * 生成给模型/用户看的命令输出摘要。
 * 合并 stdout 与 stderr（空行过滤），超长时按 limit 截断并追加 [truncated] 标记，
 * 避免 xcodebuild 的大段日志撑爆上下文；只保留前段，错误通常出现在开头附近。
 */
export function brief(item: Run, limit = 4000): string {
  const text = [item.stdout.trim(), item.stderr.trim()].filter(Boolean).join("\n")
  if (text.length <= limit) return text
  return text.slice(0, limit) + "\n...[truncated]"
}
