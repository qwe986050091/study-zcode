// INV-01 交接必须先停旧 daemon 再启动新 daemon：守住位置是 converge 内两次边界调用的先后次序；改错故障是新旧两代进程同时持有数据根锁并争抢同一端口。
// INV-02 成功边界必须覆盖 Supervisor 与 Core 同版本：守住位置是身份校验的三组版本比对；改错故障是只换了 Core 而旧 Supervisor 长期驻留却对外报告更新完成。
// INV-03 身份校验必须发生在启动动作之后：守住位置是读取身份那一行的执行时机；改错故障是把旧进程的旧身份当成新进程证据，未真正换代也判通过。
// INV-04 状态快照必须先于停止请求读取：守住位置是停止函数开头那次快照读取；改错故障是拿到停止后写出的新时间戳当基线，等待判据永真而立即放行。
// INV-05 状态不可读时必须中止交接：守住位置是两个坏态分支的抛错；改错故障是把未知状态当作已停止，进程仍在运行时继续换代。
// INV-06 锁缺失或陈旧等同无守护进程：守住位置是提前返回的那一行；改错故障是向无人监听的端点发停止命令并一直等到超时。
// INV-07 停止基线时间戳必须取自停止之前：守住位置是基线变量的捕获点；改错故障是等待逻辑失去参照，停止确认形同虚设。
// INV-08 启动器超时必须杀子进程并拒绝：守住位置是超时分支里的终止与拒绝两步；改错故障是残留的启动进程继续占用端口与数据根。
// INV-09 成功与超时只能结算一次：守住位置是 settled 标志在三条回调里的检查；改错故障是同一承诺被二次结算，或超时后仍以成功收尾掩盖失败。
// INV-10 诊断输出必须截断保留尾部：守住位置是追加函数末尾的定长裁剪；改错故障是长输出吃满内存，且真正的报错被头部噪声挤出缓冲区。
// INV-11 子进程标准输入必须忽略：守住位置是启动选项里描述符数组的首项；改错故障是守护进程继承终端输入，在无人值守场景下阻塞在读取上。
// INV-12 数据根与服务根必须显式传给子进程：守住位置是启动选项里的环境变量展开；改错故障是新进程落到默认目录，与旧实例彼此看不见对方的数据。
// INV-13 启动成功只以退出码判定：守住位置是退出码为零的提前返回；改错故障是非零退出被当成就绪，随后的身份读取只能对着死进程超时。
// INV-14 回滚必须按停、恢复、再启三步执行：守住位置是回滚函数里的调用顺序；改错故障是失败进程仍占着端口，被恢复的旧版本无法绑定。
// INV-15 缺少上一版本时不得伪装回滚：守住位置是上一版本为空的分支；改错故障是把启动失败吞成成功，或抛出误导性的已恢复文案。
// INV-16 回滚失败必须同时保留两个原因：守住位置是聚合错误的构造点；改错故障是原始启动原因被覆盖，事后无法判断是启动坏了还是恢复坏了。
// INV-17 失败路径必须以永不返回收尾：守住位置是回滚函数的返回类型与末尾抛错；改错故障是捕获分支静默续行，交接被上层当成成功。
// INV-18 进程边界必须可注入以便验证失败路径：守住位置是工厂函数默认参数的三个实现；改错故障是测试只能拉起真实进程，超时与回滚分支永远覆盖不到。
//
// 模块职责：把「更新包已落盘」推进到「新守护进程真正接管」，负责停旧、起新、校验运行身份，并在任一步失败时回滚到上一版本。
// 状态所有权：跨进程事实只认数据根下的状态快照、锁文件与当前版本指针，本模块内存里的句柄与时间戳一律不可跨进程沿用。
// 阅读顺序：先看上面 18 条不变量，再从 converge 读主干流程，最后回到停止函数、启动器与回滚函数看失败路径的分工。
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createServiceLogger } from "@zcode/services/node";
import { runtimeIdentitySchema, type ReleaseManifest, type RuntimeIdentity } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { DataRootLock } from "./lock.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseManager } from "./releaseManager.js";
import { waitForServerStopped } from "./shutdownWait.js";
import { readPersistedStatusDetailed } from "./statusSnapshot.js";
import type { UpdateDaemonHandoff } from "./updateCommand.js";

// 45 秒取的是「慢机器冷启动加上首次自检」的上限：短了会把健康的冷启动误判成失败，长了会让交接在坏镜像上长时间僵持。
// [判据] `DAEMON_START_TIMEOUT_MS` 只兜底拉起失败；就绪与否由随后 `readRuntimeIdentity` 的身份校验决定，超时本身不构成失败证据。
// [权衡] 调大能减少误杀，但失败交接的总耗时同步变长，整个回滚窗口被推后。
// 该值必须与停止等待的量级相称，一侧过宽一侧过紧会把故障定位引向错误的一侧。
// 改动它等于改交接的时间契约，压测结论要以真实冷启动分布为准，而不是以本机热缓存为准。
const DAEMON_START_TIMEOUT_MS = 45_000;
const MAX_DIAGNOSTIC_CHARS = 16_384;
const log = createServiceLogger("server-update-handoff");

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface UpdateHandoffProcessBoundary {
  stopDaemon(layout: ServerLayout): Promise<void>;
  startDaemon(layout: ServerLayout, release: ReleaseManifest): Promise<void>;
  readRuntimeIdentity(layout: ServerLayout): Promise<RuntimeIdentity>;
}

// [资源] 诊断缓冲区只保留末尾定长片段：启动失败的真正原因几乎总在尾部，头部多是启动横幅之类的噪声。
// 先拼接再统一裁剪，而不是先判断长度再决定追不追加，避免边界处把整段错误信息切掉一半。
// 到达的片段一律做字符串化兜底，因为子进程输出既可能被拆包，也可能带来非字符串对象。
// 这里既不落盘也不打日志，避免把可能含路径与令牌的输出写进长期日志，只在失败时随异常带出。
// [失败路径] 缓冲区为空时上层退化为退出码与信号描述，保证异常文案永远不会是空串。
function appendDiagnostic(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-MAX_DIAGNOSTIC_CHARS);
}

async function runDaemonLauncher(
  layout: ServerLayout,
  release: ReleaseManifest,
): Promise<ProcessResult> {
  const runtimeRoot = join(release.releaseDir, "runtime");
  const runtimeNode = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  const serverCli = join(runtimeRoot, "server-cli.js");
  // [并发] launcher 以独立子进程启动，交接进程本身不承担守护进程的生命周期，避免父进程退出时把新服务一起带走。
  // node 可执行文件从目标版本自己的运行时目录取，而不是用宿主 PATH 上的 node，保证被验证的就是即将上线的那套运行时。
  // 数据根与服务根通过显式参数和环境变量双重给出，任一处写错都会让新进程认错目录，表现为看不到旧数据。
  // 标准输入必须置为忽略：守护进程若继承终端输入，在后台无人交互的场景下会阻塞在读取上。
  // [分工] `runDaemonLauncher` 只负责 spawn 与收集输出，不等待就绪；服务是否可用由退出码与 `readRuntimeIdentity` 判定。
  const child = spawn(
    runtimeNode,
    [serverCli, "serve", "--daemon", "--server-root", layout.serverRoot, "--json"],
    {
      env: {
        ...process.env,
        ZCODE_DATA_BASE_DIR: layout.dataBaseDir,
        ZCODE_SERVER_ROOT: layout.serverRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = appendDiagnostic(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendDiagnostic(stderr, chunk);
  });
  return await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(
        new Error(
          `Timed out starting ZCode Server daemon from ${release.releaseId ?? release.version}`,
        ),
      );
    }, DAEMON_START_TIMEOUT_MS);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function stopDaemon(layout: ServerLayout): Promise<void> {
  // [事务] 读状态必须是停止动作的第一步：它同时回答「当前是否还有活进程」和「停止后凭什么确认已经停下」。
  // 基线时间戳在这里捕获，早于任何停止请求，才能把旧快照与停止后写出的新快照区分开。
  // 带细节的读取保留了非法与不可读两种坏态，普通读取会把它们折叠成缺失，从而丢掉判定能力。
  // 状态文件是跨进程唯一可信的观测点，内存里的句柄与进程号在重启之后一律不可信。
  // [失败路径] 此处一旦抛错，整个停止动作中止，宁可交接失败也不要盲停一个状态未知的守护进程。
  const persisted = await readPersistedStatusDetailed(layout);
  if (persisted.state === "invalid" || persisted.state === "unreadable") {
    throw new Error("Cannot verify daemon status before update handoff");
  }
  const baselineUpdatedAt = persisted.status?.updatedAt ?? 0;
  const lock = await new DataRootLock(layout.lockFile).inspect();
  if (lock.state === "invalid" || lock.state === "unreadable") {
    throw new Error("Cannot verify daemon lock before update handoff");
  }
  // [并发] 锁缺失说明没有进程持有数据根；锁陈旧说明持有者已死而锁文件残留，两种情况都不该再发停止命令。
  // 提前返回等价于已停止，调用方随后直接启动新版本，省掉一次注定无意义的等待。
  // 判定只依据锁的检查结果，不看进程号是否存活，避免进程号被复用造成的误判。
  // [权衡] 陈旧锁不在交接路径里清理，清理职责归启动方；这条路径只读不动，以减少并发下的写竞争。
  // 若把陈旧锁当成活进程处理，等待会一直拖到上限，外部看到的现象是更新长时间无响应。
  if (lock.state === "missing" || lock.state === "stale") return;
  await requestControl(layout.controlEndpoint, { command: "stop" });
  await waitForServerStopped(layout, baselineUpdatedAt, true);
}

async function startDaemon(layout: ServerLayout, release: ReleaseManifest): Promise<void> {
  const result = await runDaemonLauncher(layout, release);
  if (result.exitCode === 0) return;
  const diagnostic = result.stderr.trim() || result.stdout.trim();
  throw new Error(
    diagnostic ||
      `ZCode Server daemon launcher exited code=${result.exitCode ?? "null"} signal=${result.signal ?? "none"}`,
  );
}

async function readRuntimeIdentity(layout: ServerLayout): Promise<RuntimeIdentity> {
  return runtimeIdentitySchema.parse(
    await requestControl(layout.controlEndpoint, { command: "runtime-identity" }),
  );
}

// [事务] 三组版本必须同时等于目标：Supervisor、active 指针、Core 分别代表控制面、指向关系与执行体，缺一不可。
// 只比版本号会比不出同版本号的重复构建，所以发布标识存在时再逐项比一次标识。
// 缺失与空值一律记为不一致，绝不把缺省当成匹配，否则字段残缺的旧进程也能蒙混过关。
// 校验放在启动之后执行：此刻能应答的只可能是新进程，结论才具备收敛证据的意义。
// [失败路径] 任意一项不一致都直接抛错进入回滚，绝不带着半更新状态返回成功。
function assertTargetRuntimeIdentity(target: ReleaseManifest, identity: RuntimeIdentity): void {
  const mismatches: string[] = [];
  if (identity.supervisorVersion !== target.version) {
    mismatches.push(`Supervisor=${identity.supervisorVersion}`);
  }
  if (identity.activeReleaseVersion !== target.version) {
    mismatches.push(`active=${identity.activeReleaseVersion ?? "missing"}`);
  }
  if (identity.coreVersion !== target.version) {
    mismatches.push(`Core=${identity.coreVersion ?? "missing"}`);
  }
  if (target.releaseId) {
    if (identity.supervisorReleaseId !== target.releaseId) {
      mismatches.push(`Supervisor release=${identity.supervisorReleaseId ?? "missing"}`);
    }
    if (identity.activeReleaseId !== target.releaseId) {
      mismatches.push(`active release=${identity.activeReleaseId ?? "missing"}`);
    }
    if (identity.coreReleaseId !== target.releaseId) {
      mismatches.push(`Core release=${identity.coreReleaseId ?? "missing"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Updated daemon did not converge to ${target.releaseId ?? target.version}: ${mismatches.join(", ")}`,
    );
  }
}

async function rollbackHandoff(
  boundary: UpdateHandoffProcessBoundary,
  input: {
    layout: ServerLayout;
    previous: ReleaseManifest | null;
  },
  cause: unknown,
): Promise<never> {
  // [失败路径] 没有可回退版本时只能如实失败：继续等待或者假装成功，都会把环境留在无服务状态。
  // 抛出时带上原始原因，保留启动失败的真实细节，便于区分镜像损坏与配置错误。
  // 存在上一版本时走三步恢复：先停掉失败进程、再把当前指针改回去、最后按旧版本重新拉起。
  // [资源] 三步顺序不可交换，先停是为了释放端口与数据根锁，否则被恢复的旧进程根本无法绑定。
  // 回滚自身失败时聚合两个错误，避免只报回滚失败而丢掉最初的启动原因。
  if (!input.previous) {
    throw new Error("Updated daemon failed to start and no previous release is available", {
      cause,
    });
  }
  try {
    log.warn("target daemon handoff failed, restoring previous release", {
      previousReleaseId: input.previous.releaseId,
    });
    await boundary.stopDaemon(input.layout);
    await new ReleaseManager(input.layout).restoreCurrent(input.previous);
    await boundary.startDaemon(input.layout, input.previous);
  } catch (rollbackError) {
    throw new AggregateError(
      [cause, rollbackError],
      "Updated daemon handoff and previous release rollback both failed",
    );
  }
  throw new Error("Updated daemon handoff failed; previous release was restored", { cause });
}

export function createUpdateDaemonHandoff(
  boundary: UpdateHandoffProcessBoundary = {
    stopDaemon,
    startDaemon,
    readRuntimeIdentity,
  },
): UpdateDaemonHandoff {
  return {
    async converge(input): Promise<void> {
      // Bug 原因：apply-update 只换代 Core，返回成功后旧 Supervisor 会长期驻留，fallback
      // 环境又没有服务管理器触发下一次进程生命周期。成功边界必须包含 Supervisor 重启和
      // release identity 校验，不能再把新 Core ready 当作整个 daemon 已完成更新。
      log.info("stopping previous daemon for update handoff", {
        previousReleaseId: input.previous?.releaseId,
        targetReleaseId: input.target.releaseId,
      });
      await boundary.stopDaemon(input.layout);
      try {
        await boundary.startDaemon(input.layout, input.target);
        assertTargetRuntimeIdentity(input.target, await boundary.readRuntimeIdentity(input.layout));
        log.info("updated daemon runtime converged", {
          targetReleaseId: input.target.releaseId,
          version: input.target.version,
        });
      } catch (error) {
        await rollbackHandoff(boundary, input, error);
      }
    },
  };
}
