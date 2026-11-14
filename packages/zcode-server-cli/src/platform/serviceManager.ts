// ZCode Server 的平台服务管理器：把 serve 进程注册为 launchd、systemd 或 Windows 计划任务，
// 并统一提供可用性探测、注册、注销与命令执行器；本模块只产出描述符与调用系统命令，不持有进程状态。
// 设计权衡：描述符内容与落盘路径分离，调用方负责写文件，注册流程只面向命令执行器，便于测试替身与失败回滚。
// 关键约束：三条平台分支都必须幂等，失败时抛出带 cause 的错误，由上层决定是否回滚已写入的描述符。
// INV-01 描述符名称必须由 serverRoot 派生的稳定路径标识拼装；守住位置：createDaemonServiceDescriptor；改错故障：多实例互相覆盖 launchd 标签，重启后指向错误的 serverRoot。
// INV-02 Windows 使用 zcode.cmd、其余平台使用 zcode；守住位置：createDaemonServiceDescriptor 的命令拼接；改错故障：计划任务启动即退出，服务显示已运行却无监听端口。
// INV-03 服务入口固定带 --service-entry 与 --supervisor；守住位置：createDaemonServiceDescriptor 的参数数组；改错故障：系统重启后拉起裸 serve，Core 崩溃不再退避重启。
// INV-04 扩展名与 kind 一一对应，plist、service、json 不可互换；守住位置：serviceDescriptorPath；改错故障：把 json 当 unit 注册，systemctl 报无效单元且不留日志。
// INV-05 名称缺省值必须与平台无关且稳定；守住位置：createServiceDescriptor 的 name 回退；改错故障：新实例接管同名服务，旧实例停止命令误杀新进程。
// INV-06 launchd 只在异常退出时重启；守住位置：createServiceDescriptor 的 darwin 分支 KeepAlive；改错故障：用户主动停止后 daemon 立刻被拉起，形成停不掉的循环。
// INV-07 systemd 单元使用 on-failure 重启策略并挂到 default.target；守住位置：linux 分支的单元文本；改错故障：登录后不自动启动，或正常退出也被反复拉起。
// INV-08 单元与任务中的命令行必须经过 shellQuote 或双引号转义；守住位置：linux 分支与 schtasks 的 /TR 拼接；改错故障：含空格或引号的安装路径被截断，服务执行了错误命令。
// INV-09 Windows 任务以登录触发、最低权限运行；守住位置：task-scheduler 分支的 JSON 内容；改错故障：无交互会话时任务不启动，或以提权身份留下安全缺口。
// INV-10 子进程输出必须收齐后才结算；守住位置：defaultExecutorResult 的 close 监听；改错故障：错误信息被截断，注册失败时看不到真实 stderr 而误判为权限问题。
// INV-11 超时使用强杀并在信号终止时销毁本端管道；守住位置：defaultExecutorResult 的 exit 分支；改错故障：命令已死但 close 迟迟不来，detached 启动被永久阻塞。
// INV-12 非零退出必须带上 exitCode 抛出，供缺失判定复用；守住位置：defaultExecutor 的错误构造；改错故障：注销阶段无法区分服务不存在与权限不足，运行数据被误删。
// INV-13 探测 systemctl 时要补齐 XDG_RUNTIME_DIR 与 D-Bus 地址；守住位置：resolveServiceManagerEnvironment；改错故障：非交互 SSH 下 user bus 不可达，注册被误判为不支持。
// INV-14 环境未被修改时必须返回空值；守住位置：resolveServiceManagerEnvironment 的相等分支；改错故障：每层调用都复制进程环境，子进程看到漂移的变量。
// INV-15 可用性探测有 2 秒上界，注册与启动不套该超时；守住位置：isServiceManagerAvailable；改错故障：探测占满连接预算，真实注册却因短超时被误杀。
// INV-16 systemd 可用性以 manager 返回 Version 属性为准；守住位置：isServiceManagerAvailable 的 linux 分支；改错故障：chroot 或离线环境探测假成功，注册写入无人消费的单元。
// INV-17 launchd 注册先卸载旧 job 再加载与启动；守住位置：registerService 的 launchd 分支；改错故障：旧参数仍驻留内存，新 plist 未生效且难以察觉。
// INV-18 注销只容忍服务不存在，其他错误必须上抛；守住位置：unregisterService 的缺失判定；改错故障：权限失败被当成已注销，残留服务在下次开机再次拉起。
import { access } from "node:fs/promises";
import { join } from "node:path";
import { stablePathId, type ServerLayout } from "../runtime/paths.js";

export type ServicePlatform = "darwin" | "linux" | "win32";

export interface ServiceDescriptor {
  kind: "launchd" | "systemd" | "task-scheduler";
  name: string;
  content: string;
}

export interface ServiceCommandExecutor {
  run(command: string, args: readonly string[]): Promise<void>;
  runResult?: (
    command: string,
    args: readonly string[],
    options?: { timeoutMs?: number },
  ) => Promise<ServiceCommandResult>;
}

export interface ServiceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// 不变量：daemon 名称由 stablePathId 派生，同一 serverRoot 永远得到同一标签
// 失败路径：serverRoot 为空时标签退化为非法 plist 键，入参校验由调用方承担
// 资源生命周期：此处只描述启动方式，不创建目录也不写文件，落盘与清理留在调用方
// 设计权衡：参数显式携带 --server-root，避免服务从 cwd 猜测运行目录，代价是升级后必须重写描述符
export function createDaemonServiceDescriptor(options: {
  platform: ServicePlatform;
  layout: ServerLayout;
}): ServiceDescriptor {
  return createServiceDescriptor({
    platform: options.platform,
    command: join(
      options.layout.stableBinDir,
      options.platform === "win32" ? "zcode.cmd" : "zcode",
    ),
    args: ["serve", "--supervisor", "--service-entry", "--server-root", options.layout.serverRoot],
    name: `com.zhipu.zcode.server.${stablePathId(options.layout.serverRoot)}`,
  });
}

// 不变量：路径只由 serviceDir、名称与 kind 派生的扩展名三段构成，不含额外分支
// 失败路径：kind 与平台不匹配仍会拼出可写路径，不兼容要到系统命令阶段才暴露
export function serviceDescriptorPath(layout: ServerLayout, descriptor: ServiceDescriptor): string {
  const extension =
    descriptor.kind === "launchd" ? "plist" : descriptor.kind === "systemd" ? "service" : "json";
  return join(layout.serviceDir, `${descriptor.name}.${extension}`);
}

// 设计权衡：三个平台分支各自返回完整内容，不共享模板再替换，读取时无需跨分支跳转
// 不变量：未显式传 name 时回退到固定标签，单实例场景可直接注册
// 失败路径：未知 platform 落到 Windows 分支，类型层已收敛取值，运行期不再兜底
export function createServiceDescriptor(options: {
  platform: ServicePlatform;
  command: string;
  args?: string[];
  name?: string;
}): ServiceDescriptor {
  const name = options.name ?? "com.zhipu.zcode.server";
  const args = options.args ?? ["serve", "--daemon"];
  // 并发事务：卸载与加载的顺序由调用方在执行器层保证，这里只生成内容，避免半更新状态
  // 资源生命周期：RunAtLoad 只在注册时拉起一次，进程退出后的接管交给 KeepAlive 与 Supervisor
  // 失败路径：plist 中任一未转义字符都会让 launchctl 拒绝整个文件，转义统一走 escapeXml
  if (options.platform === "darwin") {
    return {
      kind: "launchd",
      name,
      // 正常 stop 会让 Supervisor 以 0 退出；只按异常退出重启，避免 launchd 的无条件
      // KeepAlive 把用户主动停止的 daemon 立即拉起。Supervisor 自身仍负责 Core 崩溃退避。
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${name}</string><key>ProgramArguments</key><array>${[options.command, ...args].map((value) => `<string>${escapeXml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`,
    };
  }
  // 设计权衡：单元挂到 default.target 而非 multi-user，覆盖没有 system 权限的普通用户场景
  // 不变量：ExecStart 的每个参数独立转义，命令路径与参数之间不允许出现裸空格
  // 失败路径：daemon-reload 失败后仍会继续 enable，上层据此回滚并删除已写入的单元文件
  if (options.platform === "linux") {
    return {
      kind: "systemd",
      name,
      content: `[Unit]\nDescription=ZCode Server\n[Service]\nExecStart=${shellQuote(options.command)} ${args.map(shellQuote).join(" ")}\nRestart=on-failure\n[Install]\nWantedBy=default.target\n`,
    };
  }
  return {
    kind: "task-scheduler",
    name,
    content: JSON.stringify({
      taskName: name,
      command: options.command,
      args,
      trigger: "logon",
      runLevel: "leastPrivilege",
    }),
  };
}

// 资源生命周期：三条 stdio 全部显式声明，stdin 置为 ignore 防止服务等待终端输入
// 并发事务：stdout 与 stderr 用字符串累加，单线程事件循环保证两个管道不会交叉写入
// 失败路径：spawn 失败走 error 事件，随后 close 仍会触发，结算唯一性由 once 保证
// 设计权衡：不继承 shell，参数以数组传递，牺牲管道能力换取注入面收敛
async function defaultExecutorResult(
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
): Promise<ServiceCommandResult> {
  const { spawn } = await import("node:child_process");
  const env = await resolveServiceManagerEnvironment(command);
  return await new Promise<ServiceCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env } : {}),
      ...(options?.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    // 资源生命周期：仅在 signal 非空时销毁读端，正常退出保留管道以便 close 收齐尾部数据
    // 失败路径：后代进程持有管道会让 close 无限等待，此处先断读端属于定向兜底而非通用超时
    // 不变量：exit 与 close 互不替代，退出码始终取自 close 回调
    child.once("exit", (_code, signal) => {
      // Bug 原因：超时只杀死命令本身，后代持有管道会让 close 继续等待，阻塞 detached 启动。
      // 信号终止时关闭本端管道；正常退出仍等待 close 收齐响应，避免丢失 Version 属性。
      if (signal !== null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    });
    child.once("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

// 失败路径：错误消息拼入 stderr 便于定位，但长度不可控，调用方不应无界落盘
// 不变量：exitCode 附着在错误对象上，缺失判定依赖它区分不存在与执行失败
async function defaultExecutor(command: string, args: readonly string[]): Promise<void> {
  const result = await defaultExecutorResult(command, args);
  if (result.exitCode !== 0) {
    const error = new Error(
      `${command} ${args.join(" ")} failed (${result.exitCode}): ${result.stderr}`,
    ) as Error & { exitCode?: number };
    error.exitCode = result.exitCode;
    throw error;
  }
}

// 设计权衡：run 与 runResult 绑在同一对象，测试替身可只实现 run，走其余探测的短路分支
// 资源生命周期：该单例无状态，可被多个注册流程共享，且不缓存任何探测结果
const defaultServiceCommandExecutor: ServiceCommandExecutor = {
  run: defaultExecutor,
  runResult: defaultExecutorResult,
};

// 不变量：仅当命令是 systemctl 且进程能拿到 uid 时才补环境，其他情形直接返回
// 失败路径：bus 套接字不存在即视为无 user bus，避免把不可达地址传给 systemctl
// 并发事务：读取 process.env 后整体复制，调用期间的外部修改不影响已构造的子进程环境
// 设计权衡：只在地址不同时返回新环境，减少不必要的复制与调试噪音
async function resolveServiceManagerEnvironment(
  command: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  if (command !== "systemctl" || typeof process.getuid !== "function") return undefined;
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim() || `/run/user/${process.getuid()}`;
  const busPath = join(runtimeDir, "bus");
  if (
    !(await access(busPath).then(
      () => true,
      () => false,
    ))
  )
    return undefined;
  const dbusAddress = process.env.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${busPath}`;
  if (
    process.env.XDG_RUNTIME_DIR === runtimeDir &&
    process.env.DBUS_SESSION_BUS_ADDRESS === dbusAddress
  ) {
    return undefined;
  }
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: dbusAddress,
  };
}

// 不变量：执行器缺少 runResult 时直接判定可用，兼容只实现 run 的轻量替身
// 失败路径：探测抛错与探测非零退出统一收敛为不可用，注册流程再单独报出完整错误
// 资源生命周期：探测子进程受 2 秒上界约束，超时被强杀，不会在后台累积
// 并发事务：探测不写入任何全局状态，多实例并发调用互不影响
export async function isServiceManagerAvailable(
  platform: ServicePlatform,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<boolean> {
  if (!executor.runResult) return true;
  try {
    // Bug 原因：非交互 SSH 可能继承一个已失效的 D-Bus 地址，systemctl/launchctl 探测会
    // 占满连接预算。能力探测必须有界；真实 register/start 仍保留完整错误，不套该短超时。
    if (platform === "linux") {
      // Bug 原因：chroot/offline 会跳过 systemctl 探测但返回 0，导致无 user bus 时误入注册。
      // 必须收到 manager 的非空属性响应才确认可用，避免依赖本地化提示或覆盖离线设置。
      const result = await executor.runResult(
        "systemctl",
        ["--user", "show", "--property=Version"],
        { timeoutMs: 2_000 },
      );
      return result.exitCode === 0 && /^Version=\S.*$/mu.test(result.stdout);
    }
    if (platform === "darwin") {
      if (typeof process.getuid !== "function") return false;
      return (
        (
          await executor.runResult("launchctl", ["print", `user/${process.getuid()}`], {
            timeoutMs: 2_000,
          })
        ).exitCode === 0
      );
    }
    return true;
  } catch {
    return false;
  }
}

// 失败路径：任一系统命令失败都会包装成带 cause 的错误，保留原始 stderr 供上层判断
// 并发事务：注册并非原子操作，launchd 的卸载与加载之间被打断会留下未加载的 plist
// 不变量：Windows 分支以覆盖标志创建同名任务，重复注册得到同一状态而非叠加
// 资源生命周期：systemd 的 enable 加 now 同时完成开机自启与本次启动，后续无需再单独启动
export async function registerService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  try {
    if (descriptor.kind === "launchd") {
      // Label 稳定但 plist 内容可能变化；先卸载旧 job，避免 load 失败后 start 唤醒旧参数。
      try {
        await executor.run("launchctl", ["unload", "-w", descriptorPath]);
      } catch (error: unknown) {
        if (!isServiceMissingError(error)) throw error;
      }
      await executor.run("launchctl", ["load", "-w", descriptorPath]);
      await executor.run("launchctl", ["start", descriptor.name]);
    } else if (descriptor.kind === "systemd") {
      await executor.run("systemctl", ["--user", "daemon-reload"]);
      await executor.run("systemctl", ["--user", "enable", "--now", descriptorPath]);
    } else {
      const parsed = JSON.parse(descriptor.content) as {
        taskName: string;
        command: string;
        args: string[];
      };
      await executor.run("schtasks", [
        "/Create",
        "/TN",
        parsed.taskName,
        "/TR",
        [parsed.command, ...parsed.args]
          .map((value) => `"${value.replaceAll('"', '\\"')}"`)
          .join(" "),
        "/SC",
        "ONLOGON",
        "/F",
      ]);
      await executor.run("schtasks", ["/Run", "/TN", parsed.taskName]);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to register service ${descriptor.name} (${descriptorPath}): ${message}`,
      { cause: error },
    );
  }
}

// 不变量：注销按 kind 分派而不读平台字段，避免平台与描述符种类不一致时走错命令
// 失败路径：Windows 先查询再删除，查询明确不存在时直接返回，省去一次必然失败的调用
// 并发事务：两个注销并发执行时，后到的缺失错误被吞掉，最终状态仍是未注册
// 设计权衡：只在缺失错误上容忍，权限与超时继续上抛，防止删除运行数据时掩盖故障
export async function unregisterService(
  descriptor: ServiceDescriptor,
  descriptorPath: string,
  executor: ServiceCommandExecutor = defaultServiceCommandExecutor,
): Promise<void> {
  try {
    if (descriptor.kind === "launchd")
      await executor.run("launchctl", ["unload", "-w", descriptorPath]);
    else if (descriptor.kind === "systemd")
      await executor.run("systemctl", ["--user", "disable", "--now", descriptorPath]);
    else {
      if (await isMissingWindowsTask(descriptor, executor)) return;
      await executor.run("schtasks", ["/Delete", "/TN", descriptor.name, "/F"]);
    }
  } catch (error) {
    // 注册命令可能在写 descriptor 后失败，卸载时 OS 中并不存在对应服务。
    // 仅容忍“未注册/不存在”，权限或命令执行等真实失败仍需阻止删除运行数据。
    if (!isServiceMissingError(error, descriptor.kind === "task-scheduler")) throw error;
  }
}

// 不变量：错误文本匹配覆盖三平台常见缺失措辞，且大小写不敏感
// 失败路径：仅在 Windows 开关打开时接受退出码 2，避免把普通失败误判为不存在
// 资源生命周期：判定为纯函数，不读取外部状态，可在任意阶段重复调用
function isServiceMissingError(error: unknown, allowWindowsFileNotFound = false): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const exitCode =
    typeof error === "object" &&
    error !== null &&
    "exitCode" in error &&
    typeof error.exitCode === "number"
      ? error.exitCode
      : undefined;
  const commonMissingMessage =
    /could not find specified service|not loaded|does not exist|specified (?:service|task).*not (?:exist|found)|unit .* not found/iu.test(
      message,
    );
  const windowsMissingMessage = /cannot find the file specified/iu.test(message);
  return (
    commonMissingMessage || (allowWindowsFileNotFound && (exitCode === 2 || windowsMissingMessage))
  );
}

// 不变量：查询成功即认为任务存在，不再依赖文本输出解析
// 失败路径：只有未找到对应的 HRESULT 才视为缺失，其余非零一律抛出
// 并发事务：查询与删除之间存在竞争窗口，删除阶段的缺失错误由注销流程兜底
// 资源生命周期：执行器不支持 runResult 时返回 false，宁可走删除命令也不跳过
async function isMissingWindowsTask(
  descriptor: ServiceDescriptor,
  executor: ServiceCommandExecutor,
): Promise<boolean> {
  if (!executor.runResult) return false;
  const result = await executor.runResult("schtasks", [
    "/Query",
    "/TN",
    descriptor.name,
    "/HResult",
  ]);
  if (result.exitCode === 0) return false;
  // schtasks /Query /HResult returns HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) for a
  // missing task. Keep permission/service failures fatal instead of treating every non-zero
  // probe result as an idempotent absence.
  if (result.exitCode === 2 || result.exitCode === 0x80070002 || result.exitCode === -2147024894)
    return true;
  const error = new Error(
    `schtasks /Query /TN ${descriptor.name} failed (${result.exitCode}): ${result.stderr}`,
  ) as Error & { exitCode?: number };
  error.exitCode = result.exitCode;
  throw error;
}

// 不变量：单引号通过闭合再重开的序列处理，任何输入都能安全嵌入单元文件
// 失败路径：该函数只适用于 POSIX shell，Windows 分支改用双引号转义，混用会破坏参数
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// 不变量：四个 XML 保留字符全部替换，替换顺序保证与号不会被二次转义
// 失败路径：遗漏与号会让 plist 在解析阶段报错，且报错位置与真实参数相距很远
// 设计权衡：不做完整 XML 规范化，只覆盖 plist 值中实际会出现的字符
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
