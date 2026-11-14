// INV-01 启动标识每次尝试唯一：守住位置 随机标识；改错故障 两次启动状态帧无法区分。
// INV-02 数据库标识只存哈希：守住位置 摘要调用；改错故障 状态帧泄露真实路径。
// INV-03 序号单调递增：守住位置 自增字段；改错故障 Host 丢弃乱序帧时丢错帧。
// INV-04 失败帧只补发一次：守住位置 布尔标记；改错故障 同一失败铺满状态流。
// INV-05 失败帧写入失败保留原错：守住位置 捕获分支；改错故障 传输异常覆盖数据库异常。
// INV-06 写帧等待回调确认：守住位置 等待承诺；改错故障 帧还在缓冲就开始写库。
// INV-07 失败分类取自统一函数：守住位置 分类调用；改错故障 界面无法区分磁盘满与权限。
// INV-08 握手先发路径再等确认：守住位置 语句顺序；改错故障 未确认就打开数据库。
// INV-09 确认行长度受限：守住位置 长度判断；改错故障 超长伪造行拖垮解析。
// INV-10 确认复用才跳过打开：守住位置 布尔判断；改错故障 无授权也跳过迁移。
// INV-11 握手超时给出明确错误：守住位置 定时器；改错故障 Host 不响应时进程永久挂起。
// INV-12 输入关闭按传输断开结算：守住位置 关闭监听；改错故障 关闭后承诺悬挂。
// INV-13 等待承诺预挂空捕获：守住位置 兜底捕获；改错故障 提前失败触发未处理拒绝。
// INV-14 准备完成先关库再通知：守住位置 语句顺序；改错故障 通知到达时库仍被占用。
// INV-15 失败通知后抛原始异常：守住位置 语句顺序；改错故障 调用方拿到通知异常。
// INV-16 清理阶段不掩盖原错：守住位置 失败判断；改错故障 关闭异常覆盖真正原因。
// INV-17 结束清掉超时定时器：守住位置 清理调用；改错故障 定时器拖住进程退出。
// INV-18 本模块不含 Provider 装配：守住位置 文件职责；改错故障 观测边界被提前越过。
//
// 模块职责：协议启动时的存储打开、迁移进度上报与观测边界握手。
// 状态所有权：启动标识、序号与失败标记都在单次调用内。
// 阅读顺序：先看进度上报，再看打开流程，最后看握手准备。
import { createHash, randomUUID } from "node:crypto";
import { SqliteSessionStore, type SqliteMigrationProgress } from "@zcode/adapters/storage";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  zcodeProtocolNotifications,
  zcodeStorageStartupStateSchema,
  type ZCodeStorageStartupState,
} from "@zcode/shared";

// attemptId 标识本次启动尝试，databaseId 是 dbPath 的哈希（不含路径本身），供冻结点关联。
// attemptId 每次启动重新生成，Host 据此区分两次启动的状态帧，不会把旧尝试的进度算成本次。
// databaseId 只保留 dbPath 的 sha256 摘要，状态帧因此不泄露用户目录。
// sequence 由 ++sequence 单调递增，Host 可据此丢弃乱序或重复的进度帧。
export async function openProtocolStartupStorage(options: {
  dbPath: string;
  output: NodeJS.WritableStream;
  onProgress?: (progress: ZCodeStorageStartupState) => void;
}): Promise<SqliteSessionStore> {
  const attemptId = randomUUID();
  const databaseId = createHash("sha256").update(options.dbPath).digest("hex");
  let sequence = 0;
  let failedReported = false;
  // failedReported 保证失败帧只补发一次：catch 里先查该标记再决定是否 report。
  // report 里的 output.write 必须等回调 resolve 才返回，防止帧还停在 JS 缓冲时就去写库。
  // errorCode 统一走 classifyDatabaseStartupError，界面才能区分磁盘满与权限不足。
  const report = async (progress: SqliteMigrationProgress) => {
    const params = zcodeStorageStartupStateSchema.parse({
      schemaVersion: 1,
      attemptId,
      databaseId,
      databaseKind: "session",
      sequence: ++sequence,
      ...progress,
    });
    failedReported ||= params.phase === "failed";
    options.onProgress?.(params);
    // phase 单调递增，Host 可据此丢弃乱序/重复帧；写回调确认控制帧已交给传输层。
    // 不能先写入 JS 缓冲后立即阻塞执行 SQL；等待 Writable 确认控制帧已交给传输层。
    await new Promise<void>((resolve, reject) => {
      options.output.write(
        `${JSON.stringify({ method: zcodeProtocolNotifications.storageStartup, params })}\n`,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  };
  try {
    await report({ phase: "checking", elapsedMs: 0 });
    return await SqliteSessionStore.openStartup({ dbPath: options.dbPath }, { onProgress: report });
  } catch (error) {
    if (!failedReported) {
      try {
        await report({
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        });
      } catch {
        /* 传输已断开时保留最初的数据库/传输异常。 */
      }
    }
    throw error;
  }
}

// 握手顺序：先发 storagePath，等 Host 回 ACK（reuse=复用上次已准备好的库）才开始打开/迁移；
// 任何一步失败都补发一条 failed 状态再抛原异常，原始存储异常优先于状态写入失败。
/** 只准备存储，不创建 Provider/MCP/工作区 runtime；Host 确认观测边界后才允许写库。 */
// prepareProtocolStartupStorage 先 write 一条 startup/storagePath，等 Host 回 ACK 后才打开数据库。
// ACK 里的 reuse 为真才跳过 SqliteSessionStore.openStartup，无授权不得跳过迁移。
// store 就绪后先 close 再 write storagePrepared，通知到达时库已不再被占用。
export async function prepareProtocolStartupStorage(options: {
  dbPath: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): Promise<void> {
  const { createInterface } = await import("node:readline");
  const { zcodeStoragePathReadySchema, classifyDatabaseStartupError } =
    await import("@zcode/shared");
  const lines = createInterface({ input: options.input });
  let timer: ReturnType<typeof setTimeout>;
  // 确认行超过 1024 字节直接 reject，防止超长伪造行拖垮 readline 解析。
  // timer 在 30_000ms 后 reject startup_status_timeout，Host 不响应时进程不会永久挂起。
  // lines 的 close 事件按 transport_closed 结算，输入提前关闭时 acknowledgement 不会悬挂。
  const acknowledgement = new Promise<boolean>((resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error("Storage observation handshake timed out"), {
            kind: "startup_status_timeout",
          }),
        ),
      30_000,
    );
    lines.once("line", (line) => {
      try {
        if (line.length > 1024) throw new Error("Invalid storage acknowledgement");
        const ack = zcodeStoragePathReadySchema.parse(JSON.parse(line));
        resolve(ack.reuse ?? false);
      } catch (error) {
        reject(error);
      }
    });
    lines.once("close", () =>
      reject(
        Object.assign(new Error("Storage preparation input closed"), { kind: "transport_closed" }),
      ),
    );
  });
  // 路径通知发送失败时也要消费已创建的等待 promise，避免未处理拒绝。
  void acknowledgement.catch(() => {});
  let store: SqliteSessionStore | undefined;
  let failure: unknown;
  const write = (frame: unknown) =>
    new Promise<void>((resolve, reject) => {
      options.output.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
  try {
    await write({ method: "startup/storagePath", params: { path: options.dbPath } });
    const reuse = await acknowledgement;
    clearTimeout(timer!);
    lines.close();
    // reuse 仅由同一次 Host 准备的成功路径集合授予；不打开连接，也不写永久跳过标记。
    if (!reuse) {
      store = await openProtocolStartupStorage(options);
      store.close();
      store = undefined;
    }
    await write({ method: "startup/storagePrepared", params: {} });
  } catch (error) {
    failure = error;
    try {
      await write({
        method: "startup/storageState",
        params: {
          schemaVersion: 1,
          attemptId: randomUUID(),
          databaseId: createHash("sha256").update(options.dbPath).digest("hex"),
          databaseKind: "session",
          sequence: 1,
          phase: "failed",
          elapsedMs: 0,
          errorCode: classifyDatabaseStartupError(error),
          ...databaseStartupErrorDetails(error),
        },
      });
    } catch {
      /* 原始存储异常优先于失败通知的 IO 异常。 */
    }
    throw error;
  } finally {
    clearTimeout(timer!);
    lines.close();
    try {
      store?.close();
    } catch (error) {
      if (!failure) throw error;
    }
  }
}
