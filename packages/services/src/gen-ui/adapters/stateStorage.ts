// gen-ui 状态存储：按 (scope, path) 把 widget 状态落成单文件 JSON，并向订阅者广播变更。
// INV-01：同一 scope 的「写记录 + 配额淘汰」必须在同一把文件锁内完成；拆开会让两个进程
//         各自读到旧目录清单，删掉对方刚写的记录（守住：set 里的 acquireFileLock 区间）。
// INV-02：目录名与文件名都是 sha256(scope/path) 的十六进制，不含任何业务字段：路径长度
//         恒定、不泄露用户数据，watcher 也能用固定正则识别本模块的文件。
// INV-03：磁盘是唯一事实；publishLatest 每次重新读盘，保证事件内容与文件一致。
// INV-04：写入必须原子（临时文件 + rename），读路径不加锁也不会看到半个 JSON。
// INV-05：单条记录 96KB、每 scope GEN_UI_STATE_MAX_ENTRIES 条，超限淘汰最旧者。
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { acquireFileLock } from "@zcode/shared/node";
import { z } from "zod";
import {
  buildGenUiScopeKey,
  GEN_UI_STATE_MAX_ENTRIES,
  genUiScopeSchema,
  genUiStateTargetSchema,
  genUiWidgetStateSchema,
  type GenUiScope,
  type GenUiStateChange,
  type GenUiStateTarget,
} from "@zcode/shared/gen-ui";
import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type { GenUiStateStorage } from "../app/ports.js";

// [资源] 先 stat 再读：超限在 IO 层拒绝，不会把任意大文件读进内存。
// 96KB 覆盖正常组件状态，同时把异常膨胀挡在渲染进程之外。
const MAX_RECORD_BYTES = 96 * 1024;
// 退避 25~400ms 配合 8s 超时：竞争主要来自同机多窗口，短退避避免把等待放大成秒级卡顿。
const LOCK_RETRIES = [25, 50, 100, 200, 400] as const;
// strict() 让多出字段也判失败：磁盘格式是跨版本契约，静默忽略未知字段会掩盖降级写回。
const recordSchema = z
  .object({ target: genUiStateTargetSchema, state: genUiWidgetStateSchema, updatedAt: z.number() })
  .strict();
// sha256 十六进制同时充当目录名与文件名，长度固定 64，watcher 才能用固定正则过滤；
// 用哈希而非原文，还避免了路径分隔符与大小写不敏感文件系统带来的碰撞。
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
// [失败路径] 只把 ENOENT 当「不存在」；EACCES/EMFILE 必须上抛，否则会把权限故障伪装成空状态。
const isMissing = (error: unknown) => (error as { code?: string })?.code === "ENOENT";

// 每个 root 一份实例：queues/notifications/lastPublished 都是进程内状态，跨 root 复用会串味。
// dispose 之后所有入口立即拒绝或返回，避免关闭与在途写入竞争。
export function createGenUiStateStorage(root: string): GenUiStateStorage {
  const log = createServiceLogger("gen-ui-state");
  const changes = new Emitter<GenUiStateChange>();
// watcher 按 scope 目录去重：同一目录只 watch 一次，多个 target 共享同一路事件。
  const watchers = new Map<string, FSWatcher>();
// [并发] 按 scope 串行化写入：Promise 链保证同一 scope 的读目录、写文件、淘汰不会交错。
  const queues = new Map<string, Promise<void>>();
// 通知链同样按文件串行，避免 watcher 事件与写入 ACK 同时到达时乱序。
  const notifications = new Map<string, Promise<void>>();
// 记录上次广播的序列化结果用于去抖；首次读取时先用它建立基线，防止把「读」误当「变」。
  const lastPublished = new Map<string, string>();
// file 到 target 的反查表：watcher 只给文件名，广播时需要原始 target 才能让订阅者识别。
  const targets = new Map<string, GenUiStateTarget>();
  let disposed = false;
// scope 目录 = root + 哈希(scope key)：不同 workspace/会话天然隔离，同 path 也不会互相覆盖。
  const directory = (scope: GenUiScope) => join(root, hash(buildGenUiScopeKey(scope)));
// 文件名只由 target.path 决定：同一路径重复写入落在同一文件，天然幂等。
  const fileFor = (target: GenUiStateTarget) =>
    join(directory(target), `${hash(target.path)}.json`);
// 读路径不加锁：原子写保证任何时刻读到的都是完整 JSON；加锁只会把并发读串行化。
  async function readRecord(file: string) {
    try {
// [资源] stat 在 readFile 之前：先读进内存再检查大小等于没设上限。
// 超限视为损坏或越界写入，直接抛错让调用方感知，而不是截断后继续。
      if ((await stat(file)).size > MAX_RECORD_BYTES)
        throw new Error("Invalid Gen UI state record size");
      return recordSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
// 每次广播都重新读盘：内存值可能落后于其他进程刚写入的内容，磁盘才是 INV-03 的事实源。
// 记录消失（被并发淘汰）时按 null 广播，让订阅者回落到初始态。
  async function publishLatest(file: string) {
    const target = targets.get(file);
    if (disposed || !target) return;
    const state = (await readRecord(file))?.state ?? null;
    const serialized = JSON.stringify(state);
// 与上次广播内容相同则跳过：写入 ACK 与 watcher 会各触发一次，去抖避免订阅者重复渲染。
    if (disposed || lastPublished.get(file) === serialized) return;
    lastPublished.set(file, serialized);
    changes.fire({ target, state });
  }
// 通知串行：watcher 事件与写入 ACK 可同时触发，后到的读必须排在先到之后，防止旧快照覆盖新通知。
  function publish(file: string) {
    // watch 事件与写入 ACK 可以同时触发；串行读取防止较早快照迟到覆盖较新通知。
    const next = (notifications.get(file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => publishLatest(file));
    notifications.set(file, next);
    void next
      .finally(() => {
        if (notifications.get(file) === next) notifications.delete(file);
      })
      .catch(() => undefined);
    return next;
  }
// observe 幂等：重复 get/set 只做 mkdir 与登记，已有 watcher 直接复用。
// disposed 检查放在 mkdir 前后各一次：close 可能正好发生在 await 期间。
  async function observe(target: GenUiStateTarget) {
    if (disposed) throw new Error("Gen UI state storage is closed");
    const dir = directory(target);
    await mkdir(dir, { recursive: true });
    if (disposed) throw new Error("Gen UI state storage is closed");
    targets.set(fileFor(target), target);
    if (watchers.has(dir)) return;
// [资源] persistent:false 让 watcher 不阻止进程退出；dispose 时仍要显式 close。
// 回调里只投递不处理：watch 回调是同步热路径，任何 await 都会打乱事件顺序。
    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename || !/^[a-f0-9]{64}\.json$/u.test(filename)) return;
      void publish(join(dir, filename)).catch((error: unknown) =>
        log.warn(undefined, "State notification failed", { error: String(error) }),
      );
    });
    watcher.on("error", (error) =>
      log.warn(undefined, "State watcher failed", { error: error.message }),
    );
    watchers.set(dir, watcher);
  }
// records 是淘汰与 list 的共同数据源：一次 readdir 再并发读全部记录，最后按 updatedAt 排序。
  async function records(scope: GenUiScope) {
    const dir = directory(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
// 并发读单条记录：文件数受 GEN_UI_STATE_MAX_ENTRIES 约束，并发量可控。
    const items = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))
        .map(async (name) => {
          const file = join(dir, name),
            record = await readRecord(file);
// 校验记录内的 scope 与请求一致：目录哈希碰撞或人工拷贝都不会把别的 scope 状态混进来。
          return record && buildGenUiScopeKey(record.target) === buildGenUiScopeKey(scope)
            ? { file, ...record }
            : null;
        }),
    );
// 按 updatedAt 降序：set 的淘汰直接 slice 即保留最新，list 也按同样顺序输出。
    return items.filter((item) => item !== null).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return {
    onChanged: changes.event,
// get 只读，但会 observe：读操作同时建立 watcher 与去抖基线，后续同 scope 变更才收得到。
// 首次读取写入 lastPublished 基线，避免把既有状态当成一次变更广播。
    async get(raw) {
      const target = genUiStateTargetSchema.parse(raw);
      await observe(target);
      const record = await readRecord(fileFor(target));
// 记录不存在时返回 null 而不是抛错：状态是可选叠加层，首次读取本就无文件。
      const state = record?.state ?? null;
      // 读取不能吞掉其他页面等待的变更通知；只为首次观察建立比较基线。
      if (!lastPublished.has(fileFor(target)))
        lastPublished.set(fileFor(target), JSON.stringify(state));
      return state;
    },
// set 以完整快照语义写入：不做字段合并，调用方传来的 state 就是权威全量。
    set(raw, value) {
      const target = genUiStateTargetSchema.parse(raw),
        state = genUiWidgetStateSchema.parse(value);
      const key = buildGenUiScopeKey(target);
// 入队前先 catch 上一环：前一次写入失败不能阻断后续写入，否则一次磁盘错误就让该 scope 永久卡死。
      const run = (queues.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          await observe(target);
          // 所有窗口复用同一会话锁；完整快照写入与容量淘汰属于同一个提交，不能各自读改写目录清单。
// [事务] 锁覆盖「读目录清单、写记录、淘汰」三件事：三者必须原子，否则并发窗口会删掉别人刚写的行。
// 拿不到锁就抛错而不是无限排队：调用方需要看到失败，静默掉写会让 UI 与磁盘分叉。
          const release = await acquireFileLock(
            join(directory(target), "state"),
            LOCK_RETRIES,
            100,
            8000,
          );
          try {
            const existing = await records(target);
// updatedAt 取 max(now, 最新+1)：单调递增，避免同毫秒写入让淘汰顺序变得不确定。
            const updatedAt = Math.max(Date.now(), (existing[0]?.updatedAt ?? 0) + 1);
// useFileLock:false：已持有 scope 锁，再让 atomicWriteText 取锁会死锁或放大等待。
            await atomicWriteText(fileFor(target), JSON.stringify({ target, state, updatedAt }), {
              useFileLock: false,
            });
// 写完保留 MAX-1 条旧记录，加上刚写的一条正好等于配额；slice 依赖上面的降序排列。
            for (const record of existing
              .filter((record) => record.file !== fileFor(target))
              .slice(GEN_UI_STATE_MAX_ENTRIES - 1))
// force:true 容忍并发淘汰已删掉的文件，ENOENT 不视为失败。
              await rm(record.file, { force: true });
          } finally {
            await release();
          }
// 本地写完主动 publish：watcher 事件可能延迟或合并，主动广播保证同进程订阅者立刻看到。
          await publish(fileFor(target));
        });
      queues.set(key, run);
      void run
        .finally(() => {
          if (queues.get(key) === run) queues.delete(key);
        })
        .catch(() => {});
      return run;
    },
    async list(raw) {
      return (await records(genUiScopeSchema.parse(raw)))
        .slice(0, GEN_UI_STATE_MAX_ENTRIES)
        .map((entry) => ({ path: entry.target.path, state: entry.state }));
    },
// [资源] 先置 disposed 再收资源：后续 publish/observe 在入口直接返回，不再产生新事件。
    dispose() {
      disposed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      targets.clear();
      lastPublished.clear();
      changes.dispose();
    },
  };
}
