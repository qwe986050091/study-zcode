// 引导记录服务的持久化层：把「询问结果」与「决定」落成一份设备级 JSON（onboarding-record.json）。
// 单独成文件而不是塞进 setting.json：setting.json 固定落在 home 供启动引导定位 dataBaseDir，
// 而本文件跟随 dataBaseDir，属于设备数据；混写会让自定义数据目录的用户丢记录。
// INV-01：同一 userId（含 null）在 entries 内至多一条（守住者：appendRecord、claimAnonymousRecord）；
//         破坏后上传侧会重复上报同一用户的答案，本地回放取最后一条也会掩盖覆盖语义。
// INV-02：entries 与同一 userId 的 decisions 互斥（守住者：appendRecord 覆盖时清 decisions、
//         dismissOnboarding 见 entry 即 return）；破坏后会出现「已答完又被判为 dismissed」。
// INV-03：文件内 deviceMid 是权威值，调用方传入值只用于比对（守住者：appendRecord）；
//         破坏后设备关联会随调用方偶发抖动而断开，且无法从记录里恢复。
// INV-04：新文件 version 恒为 2，读取侧不写迁移器（守住者：createFile）；schema 解析失败
//         按「从未记录」处理而不是抛错，让损坏文件被下一次写入自然重建，代价是丢一次历史。
// INV-05：所有写路径都经 enqueueWrite 串行化（守住者：createOnboardingRecordService）；
//         破坏后 read-modify-write 会互相覆盖，匿名条目可能在移交时被旧快照抹掉。
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  onboardingDecisionSchema,
  onboardingRecordEntrySchema,
  onboardingRecordFileSchema,
} from "@zcode/shared";
import { appSettingsOccupationEnum } from "@zcode/shared";
import type {
  OnboardingRecordEntry,
  OnboardingRecordEntryInput,
  OnboardingRecordFile,
} from "@zcode/shared";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import { getAppConfigDir } from "../paths.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  CreateOnboardingRecordServiceOptions,
  IOnboardingRecordService,
  OnboardingSettingsSyncPatch,
} from "./onboardingRecord.js";

const logger = createServiceLogger("onboardingRecordService");

function getRecordFile(): string {
  // 记录是设备级数据，必须跟随 dataBaseDir（用户自定义数据目录时落在其 .zcode/v2 下，
  // 与 telemetry-state.json 一致），不能学 setting.json 固定写 home——setting.json 留在 home
  // 只是启动引导需要固定位置读取 dataBaseDir，不代表其他设备数据的落点。
  return join(getAppConfigDir(), "onboarding-record.json");
}

/**
 * 读取记录文件；文件不存在返回 null，内容损坏（手改/写坏）时同样返回 null 并 warn——
 * 损坏文件等价于"从未记录"，重新触发引导后在下次 append 时重建。
 */
async function readRecordFile(filePath: string): Promise<OnboardingRecordFile | null> {
// readFile 失败与解析失败必须分成两段 catch：只有 ENOENT 是「正常未记录」，其余要留 warn；
// 对外一律降级为 null——引导是可选流程，读失败最多重复问一次，抛错会挡住主界面。
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    logger.warn(undefined, "read onboarding record failed:", err);
    return null;
  }
  try {
// [失败路径] 用 schema.parse 而不是 safeParse 后手工挑字段：拒绝半合法文件比带着缺字段
// 继续写更安全，下游 append 依赖 entries/decisions 一定存在；异常由下一段 catch 收口。
    return onboardingRecordFileSchema.parse(JSON.parse(raw));
  } catch (cause) {
    logger.warn(undefined, "invalid onboarding record json, treating as missing. error:", cause);
    return null;
  }
}

export function createOnboardingRecordService(
  options: CreateOnboardingRecordServiceOptions,
): IOnboardingRecordService {
  // 串行化写：引导保存与并发触发判定同时发生时不丢条目。
  let writeQueue: Promise<unknown> = Promise.resolve();
// [并发] 队列用 then(task, task) 而不是 then(task)：前一个任务失败时后续写仍要执行，
// 否则一次磁盘错误会永久 poison 队列，之后所有 append/shouldOnboard 都静默不落盘。
  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => {});
    return queued;
  };
  const createFile = (deviceMid: string): OnboardingRecordFile => ({
    version: 2,
    deviceMid,
    entries: [],
    decisions: [],
  });
  const hasIdentityRecord = (file: OnboardingRecordFile, userId: string | null): boolean =>
    file.entries.some((entry) => entry.userId === userId) ||
    file.decisions.some((decision) => decision.userId === userId);

  return {
// [事务] appendRecord 的「读-改-写」必须整体在队列内完成：若把 readRecordFile 提到队列外，
// 两个并发保存会基于同一份旧快照各写一次，后写者静默覆盖先写者刚落的条目。
    async appendRecord(deviceMid: string, entry: OnboardingRecordEntryInput): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const existing = await readRecordFile(filePath);
        // deviceMid 以文件内已有值为权威：本地文件不变是设备关联的前提，
        // 调用方传入不同值只说明异常（如 getDeviceId 行为变化），记录并沿用旧值。
        let file: OnboardingRecordFile;
        if (existing) {
          if (existing.deviceMid !== deviceMid) {
            logger.warn(
              undefined,
              "deviceMid mismatch, keep existing:",
              existing.deviceMid,
              "incoming:",
              deviceMid,
            );
          }
          file = existing;
        } else {
          file = createFile(deviceMid);
        }
        const record: OnboardingRecordEntry = {
          userId,
          ...entry,
          uploadState: "pending",
        };
        // 每 userId（含 null）至多一条：同一用户重复完成引导（debug 重置后再答等）覆盖旧条目，
        // 而不是追加——覆盖后的新答案重新置 pending，等待上传。
// INV-01 的落点：先定位再原地替换，保证同一 userId 只有一条；用 findIndex 而非 find
// 是为了拿到下标做覆盖，同时保留条目在数组中的相对顺序（便于回放时按时间观察）。
        const previousIndex = file.entries.findIndex((item) => item.userId === userId);
        const validated = onboardingRecordEntrySchema.parse(record);
        if (previousIndex >= 0) file.entries[previousIndex] = validated;
        else file.entries.push(validated);
// INV-02 的落点：写入答案后同一 userId 的 decision 必须清空，否则 hasIdentityRecord
// 会让 shouldOnboard 认为「已处理」，用户新答的答案永远不会被上传消费。
        file.decisions = file.decisions.filter((decision) => decision.userId !== userId);
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

// 登录后把匿名（userId === null）记录移交给当前用户。只在确实没有本用户记录时执行：
// 否则会用匿名时期更旧的答案盖掉用户已有的答案，等于回退用户的选择。
    async claimAnonymousRecord(): Promise<void> {
      const userId = await options.loadUserId();
      if (!userId) return;
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
        if (hasIdentityRecord(file, userId)) return;
        // 兼容旧版重复文件取最后一条 null；移交是改写，不保留匿名副本。
// 从尾部倒序找：旧版本可能多次追加 null 条目，末尾才是最新答案。移交就地改写 userId，
// 不新建条目，保持 decidedAt 与答案字段与匿名时完全一致，上传侧看不出差异。
        for (let i = file.entries.length - 1; i >= 0; i -= 1) {
          if (file.entries[i]!.userId === null) {
            file.entries[i] = onboardingRecordEntrySchema.parse({
              ...file.entries[i]!,
              userId,
            });
            await atomicWriteText(filePath, JSON.stringify(file, null, 2));
            return;
          }
        }
// 没有匿名 entry 时再找匿名 decision：只关闭未答题的用户也需要随登录身份迁移，
// 否则登录后会被重新判定为未处理，再弹一次已经明确关掉的引导。
        for (let i = file.decisions.length - 1; i >= 0; i -= 1) {
          if (file.decisions[i]!.userId !== null) continue;
          file.decisions[i] = onboardingDecisionSchema.parse({ ...file.decisions[i]!, userId });
          await atomicWriteText(filePath, JSON.stringify(file, null, 2));
          return;
        }
      });
    },

    async shouldOnboard(deviceMid: string): Promise<boolean> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
// 纯读判定放在队列外：引导入口是启动热路径，没必要为一个布尔值排队等前面的写入。
// 代价是可能读到写了一半的旧值，但这个判定只会偏保守（多问一次），不会误判已完成。
      if (file && hasIdentityRecord(file, userId)) return false;
// 已有本地任务 = 老用户：不该弹引导，但仍要落一条 decision 记住「已豁免」，
// 否则每次启动都重新扫任务库，且用户清空任务后会被突然引导到不该出现的引导页。
      if (!(await options.hasExistingLocalTask())) return true;
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const current = (await readRecordFile(filePath)) ?? createFile(deviceMid);
        if (hasIdentityRecord(current, userId)) return;
// [事务] 这里重新读一次而不是复用上面的 file：两次读之间可能有 appendRecord 写入，
// 用旧快照 push 会把它覆盖掉——decision 只能追加在最新快照上。
        current.decisions.push(
          onboardingDecisionSchema.parse({
            userId,
            status: "existing_local_user",
            reason: "existing_local_task",
            decidedAt: new Date().toISOString(),
          }),
        );
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(current, null, 2));
      });
      return false;
    },

// 用户主动关闭引导：与 shouldOnboard 的 existing_local_user 共用 decisions 集合，
// 只用 status 区分来源，便于统计「主动关」与「老用户豁免」的比例。
    async dismissOnboarding(deviceMid: string): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = (await readRecordFile(filePath)) ?? createFile(deviceMid);
// INV-02 的读侧：已答过题就不再写 dismissed，否则 entry 与 decision 并存，
// 同步设置时读到哪一条取决于遍历顺序，用户会看到与答案矛盾的偏好。
        if (file.entries.some((entry) => entry.userId === userId)) return;
        const decision = onboardingDecisionSchema.parse({
          userId,
          status: "dismissed",
          reason: "user_closed",
          decidedAt: new Date().toISOString(),
        });
        const index = file.decisions.findIndex((item) => item.userId === userId);
        if (index >= 0) file.decisions[index] = decision;
        else file.decisions.push(decision);
        await mkdir(join(filePath, ".."), { recursive: true });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

// 取「最后一条」而不是第一条：旧版本是追加语义，同一用户可能有多条，末尾那条才是
// 最新答案；新版本的覆盖语义下循环同样只命中一条，无需分支。
    async getLatestEntry(): Promise<OnboardingRecordEntry | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      return latest ?? null;
    },

// 把引导答案映射回设置。方向是「记录 → 设置」单向：调用方只拿 patch，不在这里写
// setting.json，避免本服务反向依赖设置写入链路而形成双向同步。
    async syncSettingsFromRecord(): Promise<OnboardingSettingsSyncPatch | null> {
      const userId = await options.loadUserId();
      const file = await readRecordFile(getRecordFile());
      if (!file) return null;
      // append 是覆盖语义，正常每 userId 至多一条；兼容旧版本的重复追加文件时取最后一条。
      let latest: OnboardingRecordEntry | undefined;
      for (const entry of file.entries) {
        if (entry.userId === userId) latest = entry;
      }
      if (!latest) return null;
      // 跳过页记 null：回填保守默认，与引导跳过写 settings 的行为一致（职业 other、偏好关）。
      // record 的 occupation 是非枚举字符串（职业列表会演进），窄化到 settings 的枚举；
      // 旧版本可能落过已收窄/未知的职业值，未知值回填 other，与推荐池的兜底一致。
      const occupation = appSettingsOccupationEnum.safeParse(latest.occupation);
      return {
        onboardingOccupation: (occupation.success ? occupation.data : null) ?? "other",
        proactiveSuggestionsEnabled: latest.proactiveSuggestionsEnabled ?? false,
        memoryEnabled: latest.memoryEnabled ?? false,
      };
    },

// 只更新已存在的条目，不新建：没有引导记录却来改偏好说明调用方状态不一致，
// 静默 return 比凭空造一条缺答案的记录安全，后者会被当成「已完成引导」。
    async updateRecordPreferences(
      patch: Partial<
        Pick<OnboardingRecordEntryInput, "memoryEnabled" | "proactiveSuggestionsEnabled">
      >,
    ): Promise<void> {
      const userId = await options.loadUserId();
      await enqueueWrite(async () => {
        const filePath = getRecordFile();
        const file = await readRecordFile(filePath);
        if (!file) return;
// 用 findLastIndex 与 getLatestEntry 的「取最后一条」保持同一语义，
// 否则旧版重复文件下会改到旧条目，用户看到偏好没生效。
        const index = file.entries.findLastIndex((entry) => entry.userId === userId);
        if (index < 0) return;
        file.entries[index] = onboardingRecordEntrySchema.parse({
          ...file.entries[index],
          ...patch,
        });
        await atomicWriteText(filePath, JSON.stringify(file, null, 2));
      });
    },

    async getRecords(): Promise<OnboardingRecordFile | null> {
      return readRecordFile(getRecordFile());
    },

// [资源] 删除也走队列：与进行中的 append 竞争时，先写后删的顺序必须确定，
// 否则 reset 之后残留一条旧记录，会把用户重新判为已完成引导。
    async clearRecords(): Promise<void> {
      await enqueueWrite(async () => {
        await rm(getRecordFile(), { force: true });
      });
    },
  };
}
