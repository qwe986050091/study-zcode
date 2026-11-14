// INV-01 强制与否只能由 --force 决定：守住位置是 runUpdateCommand 开头的 force 解析；改错故障是非强制路径跳过运行任务守卫，更新覆盖正在执行的任务。
// INV-02 失败一律以异常上抛，绝不在函数内返回非零码：守住位置是两个命令函数内不存在返回非零的分支；改错故障是被吞掉的错误让调用方以为成功，进程以 0 退出。
// INV-03 控制端响应必须先过 schema 解析再判断状态：守住位置是每次请求之后的解析调用；改错故障是协议漂移被当成正常结果，守卫失效放行更新。
// INV-04 运行任务守卫必须在下载前与准备完成后各检查一次：守住位置是两处 blocked 分支；改错故障是准备阶段已写入 pending release，拒绝时留下孤儿产物。
// INV-05 拒绝更新前必须尽力清理准备产物：守住位置是 discard 的调用点；改错故障是磁盘残留旧产物，下次更新拿到过期版本。
// INV-06 清理失败不得掩盖原始错误：守住位置是尽力清理函数的异常分支；改错故障是用户看到清理报错，却找不到真正的运行任务提示。
// INV-07 控制端点不可用属于降级而非失败：守住位置是三个错误码的白名单判断；改错故障是守护进程未启动时，本地归档更新被误判为失败。
// INV-08 只有探测成功才允许走热更新分支：守住位置是 daemonOnline 的赋值；改错故障是向不存在的端点发命令，更新中断在半途。
// INV-09 归档路径必须唯一且为绝对路径：守住位置是单值选项读取与绝对路径校验；改错故障是相对路径按当前工作目录解析到错误文件。
// INV-10 选项后紧跟另一个选项时必须立即报错：守住位置是读取函数对下一个参数前缀的判断；改错故障是 --force 被当成归档路径吞掉，更新目标错乱。
// INV-11 进度事件只在 json 模式且显式 --progress 时输出：守住位置是进度回调的双条件；改错故障是普通文本模式混入 JSON 行，解析方直接崩溃。
// INV-12 每条输出必须整行写入并以换行结尾：守住位置是标准输出辅助函数的拼接；改错故障是两条事件粘成一行，下游无法按行切分。
// INV-13 restart 阶段必须在真正重启之前发出：守住位置是热更新分支的调用顺序；改错故障是用户看不到重启提示，以为命令卡死。
// INV-14 离线安装必须走带事务的切换：守住位置是 daemonOnline 为假的分支；改错故障是切换失败后 current 指向半装版本，服务无法启动。
// INV-15 完成更新必须在事务提交之后执行：守住位置是离线分支的两步顺序；改错故障是提前清理备份，回滚失去依据。
// INV-16 热更新成功后必须把旧版本与新版本都交给对账：守住位置是对账调用的入参；改错故障是对账拿不到基线，旧版本文件长期残留。
// INV-17 应用完成后磁盘上必须有对应的当前版本：守住位置是回读当前版本后的空值检查；改错故障是打印成功提示，实际没有可运行版本。
// INV-18 应用成功路径必须把清理句柄置空：守住位置是成功分支内的清零；改错故障是刚装好的产物被误删，下次启动找不到版本。
//
// 模块职责：实现 server update 的两条 CLI 入口，一条基于本地归档、一条基于在线准备，统一负责参数校验、运行任务守卫、准备产物清理与退出码语义。
// 状态所有权：pending 与 current 版本归 ReleaseManager，运行任务守卫归控制端，本文件只持有 daemonOnline 与 cleanup 句柄这类一次性会话状态。
// 阅读顺序：先看上面的 INV 表，再读参数读取与错误分类两个辅助函数，最后按非强制与强制两条分支读两个命令入口。
import { updatePreparationResultSchema } from "../contracts.js";
import { requestControl } from "../ipc/controlClient.js";
import { createServiceLogger } from "@zcode/services/node";
import { isAbsolute } from "node:path";
import { currentServerTarget } from "./manifest.js";
import type { ServerLayout } from "./paths.js";
import { ReleaseInstaller } from "./releaseInstaller.js";
import { ReleaseManager } from "./releaseManager.js";
import { prepareOnlineUpdate } from "./updatePreparation.js";
import {
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerInstallProgress,
} from "@zcode/shared";
import { ControlRequestError } from "../ipc/controlError.js";
import type { ReleaseManifest } from "../contracts.js";

interface UpdateCliIO {
  stdout?: { write(value: string): void };
}

export interface UpdateDaemonHandoff {
  converge(input: {
    layout: ServerLayout;
    previous: ReleaseManifest | null;
    target: ReleaseManifest;
  }): Promise<void>;
}

function readSingleOption(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) throw new Error(`${name} may only be specified once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}

function isControlEndpointUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED" || error.code === "EINVAL")
  );
}

function stdout(io: UpdateCliIO, value: unknown): void {
  io.stdout?.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

function isRunningTaskUpdateGuard(error: unknown): boolean {
  return (
    (error instanceof ControlRequestError &&
      error.code === SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) ||
    (error instanceof Error && error.message.includes("Running tasks require --force for update"))
  );
}

function createRunningTaskUpdateGuard(): ControlRequestError {
  return new ControlRequestError(
    SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
    "Running tasks require --force for update",
    false,
  );
}

const log = createServiceLogger("server-update-command");

// [权衡] 本地归档更新不经过在线准备，所以把归档参数的形态校验全部做完，再触碰磁盘。
// 顺序固定为：读选项、判缺失、判绝对路径、解析强制标记，任何一步失败都发生在副作用之前。
// 返回值只保留 0 这一种成功码，失败统一上抛，由调用方映射成非零退出码，避免两套语义并存。
// [资源] 安装归档一旦开始就会解压写盘，中途不回头，前面的校验必须把明显错误挡在门外。
// 重启与对账能力以参数注入，让本函数在测试中可以替换掉真实的进程重启。
export async function runLocalArchiveUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
  updateDaemonHandoff?: UpdateDaemonHandoff,
): Promise<number> {
  const archivePath = readSingleOption(argv, "--from-archive");
  if (!archivePath) throw new Error("--from-archive requires a path");
  if (!isAbsolute(archivePath)) throw new Error("--from-archive must be an absolute path");
  const force = argv.includes("--force");
  // [权衡] 进度只在 json 且显式给了 --progress 时输出，普通文本模式保持输出干净。
  // 安装解压可能持续很久，没有阶段提示时用户会以为命令已经挂起。
  // 不默认开启，是为了让 JSON 消费者拿到的对象流不被进度行混杂。
  // 阶段值直接透传安装器定义的类型，本函数不重新编排阶段，避免两侧语义漂移。
  // [资源] 每次回调只做一次整行写入，不缓存也不合并，保证进度实时可见。
  const onProgress = (phase: SourceServerInstallProgress["phase"]): void => {
    if (json && argv.includes("--progress")) {
      stdout(io, {
        type: "source-server-install-progress",
        phase,
      } satisfies SourceServerInstallProgress);
    }
  };
  // [并发] 这里只探测一次守护进程是否在线，结果决定后续走热更新还是纯离线切换。
  // 非强制模式用准备命令探活，因为守护进程不在线时它会以连接类错误快速失败。
  // 强制模式改用状态命令探活，跳过运行任务守卫但仍需知道能否触发热重启。
  // 连接类错误视为离线并可继续，其它错误必须原样上抛，不能把协议或权限问题当成离线。
  // 该标记在中途不再翻转，后续所有分支都基于这一次快照，避免半在线状态导致分支摇摆。
  let daemonOnline = false;
  if (!force) {
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      daemonOnline = true;
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  } else {
    try {
      await requestControl(layout.controlEndpoint, { command: "status" });
      daemonOnline = true;
    } catch (error) {
      if (!isControlEndpointUnavailable(error)) throw error;
    }
  }
  const releaseManager = new ReleaseManager(layout);
  const previous = await releaseManager.readCurrent();
  const prepared = await new ReleaseInstaller(layout).installArchive({
    archivePath,
    target: currentServerTarget(),
    onProgress,
  });
  if (daemonOnline) {
    if (!force) {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") throw createRunningTaskUpdateGuard();
    }
    // [失败路径] 这条进度必须在真正触发热重启之前发出，否则用户永远等不到它。
    // 此后进程可能被替换，任何还想告知用户的信息都必须提前输出完毕。
    // 应用失败会向上抛出，此时进度停在重启阶段，用户能判断故障发生在哪一步。
    // [并发] 重启期间不重试也不重复触发应用，重复调用会让两个进程争抢同一份版本。
    // 版本对账安排在应用之后，只有新进程成功接管才值得比对旧版本与新版本。
    onProgress("restart");
    await applyUpdate();
    await updateDaemonHandoff?.converge({ layout, previous, target: prepared });
    const result = { applied: true, installed: false, version: prepared.version };
    if (json) stdout(io, result);
    else stdout(io, `ZCode Server ${prepared.version} updated`);
    return 0;
  }
  // [事务] 离线路径没有守护进程兜底，切换失败必须能把当前指针退回旧版本。
  // 旧版本为空表示首次安装，事务只需保证失败时不留下半装的当前版本。
  // [失败路径] 事务抛出后不再继续完成更新，备份保留下来供人工恢复。
  // [资源] 完成更新放在事务提交之后，早一步清理会让回滚失去原始文件。
  // 结果里的首次安装标记由旧版本是否为空推导，让脚本能区分首装与升级。
  await releaseManager.applyPendingWithTransaction(previous);
  await releaseManager.completeUpdate();
  const result = { applied: true, installed: previous === null, version: prepared.version };
  if (json) stdout(io, result);
  else stdout(io, `ZCode Server ${prepared.version} ${previous ? "updated" : "installed"}`);
  return 0;
}

async function discardPreparedUpdateBestEffort(
  discard: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!discard) return;
  try {
    await discard();
  } catch (error: unknown) {
    // 准备产物清理属于非关键收尾；直接 await discard 会让清理失败覆盖
    // running-task guard 或 control socket 的原始错误，导致用户看到错误的排障方向。
    log.warn("failed to discard prepared update after command failure", error);
  }
}

export async function runUpdateCommand(
  argv: readonly string[],
  io: UpdateCliIO,
  json: boolean,
  layout: ServerLayout,
  applyUpdate: () => Promise<unknown>,
  updateDaemonHandoff?: UpdateDaemonHandoff,
): Promise<number> {
  const previous = await new ReleaseManager(layout).readCurrent();
  const force = argv.includes("--force");
  let discardPreparedUpdate: (() => Promise<void>) | undefined;
  if (!force) {
    // prepareOnlineUpdate 会下载、解压并写入 pending release；旧流程在准备完成后
    // 才由 apply-update 检查运行任务，导致 guard 拒绝时仍留下网络和磁盘副作用。先检查已知的
    // 运行任务，并在准备完成后再次检查；最终 apply-update guard 仍覆盖最后一小段竞态。
    const result = updatePreparationResultSchema.parse(
      await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
    );
    if (result.status === "blocked") throw createRunningTaskUpdateGuard();
  }
  // [资源] 这一步才开始联网下载并解压，前面的守卫检查越早，浪费的带宽越少。
  // 返回结果可能带清理句柄，它是撤销准备产物的唯一入口，必须立刻保存下来。
  // [权衡] 准备与提交拆成两步，是为了让运行任务守卫能在拿到产物后、真正切换前再拦一次。
  // 已是最新版本时也要走统一的输出路径，保证 JSON 与文本两种格式行为一致。
  // 准备阶段自身抛出异常时不接管清理，此时约定由安装器负责收拾半成品。
  const preparation = await prepareOnlineUpdate(layout);
  discardPreparedUpdate = "discard" in preparation ? preparation.discard : undefined;
  if (preparation.status === "up-to-date") {
    if (json) stdout(io, preparation);
    else stdout(io, `ZCode Server ${preparation.version} is already up to date`);
    return 0;
  }
  if (!force && discardPreparedUpdate) {
    const discard = discardPreparedUpdate;
    try {
      const result = updatePreparationResultSchema.parse(
        await requestControl(layout.controlEndpoint, { command: "prepare-update" }),
      );
      if (result.status === "blocked") {
        await discardPreparedUpdateBestEffort(discard);
        discardPreparedUpdate = undefined;
        throw createRunningTaskUpdateGuard();
      }
    } catch (error: unknown) {
      if (isRunningTaskUpdateGuard(error)) throw error;
      await discardPreparedUpdateBestEffort(discard);
      discardPreparedUpdate = undefined;
      throw error;
    }
  }
  try {
    await applyUpdate();
    discardPreparedUpdate = undefined;
    const target = await new ReleaseManager(layout).readCurrent();
    // [失败路径] 应用声称成功但当前版本为空，属于状态不一致，必须报错而不是打印成功。
    // `readInstalledVersion` 同时兜住文件被外部清理或并发覆盖，缺失时返回 undefined。
    // 版本号从磁盘回读而不是复用内存值，避免输出一个并未真正生效的版本。
    // 对账拿到旧版本与新版本，才能判断哪些文件该被删除、哪些该保留。
    // [并发] 这里不重试应用动作，失败就是失败，重试只会把不确定状态放大。
    if (!target) throw new Error("Applied release is missing from current.json");
    await updateDaemonHandoff?.converge({ layout, previous, target });
    const result = { applied: true, version: target.version };
    if (json) stdout(io, result);
    else stdout(io, `ZCode Server ${target.version} updated`);
    return 0;
  } catch (error: unknown) {
    if (isRunningTaskUpdateGuard(error)) {
      await discardPreparedUpdateBestEffort(discardPreparedUpdate);
      discardPreparedUpdate = undefined;
    }
    throw error;
  }
}
