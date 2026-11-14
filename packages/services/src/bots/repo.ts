// bots/repo.ts — Bot 配置与运行态（v3）的文件仓储。
//
// INV-01 v3 文件存在时只认 v3；解析失败必须直接抛错，不能回退旧文件，
//        否则用户的新配置会被旧快照静默覆盖。
// INV-02 迁移只发生在“v3 不存在”的一次性路径里，且必须在同一文件锁内落盘，
//        否则两个进程会各自迁移出不同结果。
// INV-03 所有读改写必须持有同一路径的 withFileLock；跨 Bot / cursor 的更新
//        共用同一把 withFileLock，防止跨 Bot 写丢失。
// INV-04 updateContext 返回 undefined 表示删除该 Bot 的运行态；空对象不能让
//        否则调用方会误以为写入成功。
// [失败路径] 读取只吞 ENOENT；其他 I/O 或 JSON 解析错误必须上抛。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  botsConfigFileSchema,
  botsStateFileSchema,
  type BotsConfigFile,
  type BotsStateFile,
  type BotContextState,
} from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import {
  BOTS_CONFIG_FILE,
  BOTS_LEGACY_CONFIG_FILE,
  BOTS_LEGACY_STATE_FILE,
  BOTS_V2_STATE_FILE,
  BOTS_STATE_FILE,
  createDefaultBotsConfig,
} from "./config.js";
import { importLegacyBotConfig, importLegacyBotState } from "./storageMigration.js";

// 可选读取：只有“文件不存在”算空，损坏的 JSON 必须暴露。
async function readOptionalJson(path: string): Promise<unknown | undefined> {
  try {
    // readFile 与 JSON.parse 共用一个 try：磁盘 I/O 错误和 JSON 语法损坏都落到同一条 catch，由下一分支按错误码区分。
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // 只有 ENOENT 表示文件从未创建；其他 I/O 错误与 JSON 语法错误必须原样上抛，否则损坏配置会被当成空配置重建。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// 私有权限 + 临时文件原子替换；JSON 末尾补换行，便于 diff。
async function writeJson(path: string, value: unknown): Promise<void> {
  // 序列化成两空格缩进并补尾换行：缩进便于人工排查，尾换行使 git diff 只标记真正变化的行。
  await atomicWritePrivateTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// configDir 在实例化时固定，避免进程运行中被环境变量改写。
export class BotsRepo {
  private readonly configDir = getAppConfigDir();
  // 读配置：v3 必须优先，旧文件只在 v3 缺失时读取一次。
  async readConfig(): Promise<BotsConfigFile> {
    const path = join(this.configDir, BOTS_CONFIG_FILE);
    return withFileLock(path, async () => {
      // 锁内先读现有 v3 文件：读写共用同一 path 锁，防止另一进程在解析与落盘之间插入写入造成丢更新。
      const current = await readOptionalJson(path);
      // 回滚兼容：v3 已存在就只认 v3；损坏时暴露错误，绝不能恢复旧 Bot 或覆盖用户新修改。
      if (current !== undefined) return botsConfigFileSchema.parse(current);
      // 只有 v3 缺失才探测旧配置一次：旧文件只是迁移输入，绝不能在 v3 存在时充当回退来源。
      const legacy = await readOptionalJson(join(this.configDir, BOTS_LEGACY_CONFIG_FILE));
      const config = botsConfigFileSchema.parse(
        legacy === undefined ? createDefaultBotsConfig() : importLegacyBotConfig(legacy),
      );
      // 迁移结果在同一把锁内立即落盘：拖到锁外写会让两个进程各自迁移出不同的 Bot 列表。
      await writeJson(path, config);
      return config;
    });
  }

  // 写入前先 parse，保证磁盘上不会出现未归一化的配置。
  async writeConfig(config: BotsConfigFile): Promise<BotsConfigFile> {
    // 写边界先过 schema：默认值补齐与非法字段剔除都发生在此处，磁盘上不会出现半合法配置。
    const parsed = botsConfigFileSchema.parse(config);
    const path = join(this.configDir, BOTS_CONFIG_FILE);
    await withFileLock(path, () => writeJson(path, parsed));
    // 返回校验后的对象而不是入参：调用方基于返回值继续计算时，看到的就是磁盘上的同一份内容。
    return parsed;
  }

  // 运行态读取同样必须走文件锁，否则会读到迁移中的半成品。
  async readState(): Promise<BotsStateFile> {
    const path = join(this.configDir, BOTS_STATE_FILE);
    // 整份读取也走文件锁：迁移可能正在写临时文件，无锁读取会拿到只写了一半的 JSON。
    return withFileLock(path, () => this.readStateUnlocked(path));
  }

  // 已持锁版本；调用方不要再嵌套 withFileLock。
  private async readStateUnlocked(path: string): Promise<BotsStateFile> {
    const current = await readOptionalJson(path);
  // v3 存在即权威；损坏时必须抛错，不能重建。
    if (current !== undefined) return botsStateFileSchema.parse(current);
  // 迁移阶梯：v3 → v2 → v1；只读取第一个存在的快照。
    // 迁移阶梯只取第一个存在的快照：v2 在时不再看 v1，避免两份历史被合并成重复 Bot。
    const v2 = await readOptionalJson(join(this.configDir, BOTS_V2_STATE_FILE));
    const legacy =
      v2 === undefined ? await readOptionalJson(join(this.configDir, BOTS_LEGACY_STATE_FILE)) : v2;
    // 历史全缺时生成 version:3 的空状态，保证后续 updateContext 总能拿到可解析的 bots 容器。
    const state = botsStateFileSchema.parse(
      legacy === undefined ? { version: 3, bots: {} } : importLegacyBotState(legacy),
    );
    // 在同一文件锁内固定迁移结果；后续登录/套餐变化不再重新解释旧身份。
  // 迁移结果必须在同一把锁内落盘，否则会与其他进程互相覆盖。
    await writeJson(path, state);
    return state;
  }

  /** 锁覆盖完整读改写，避免两个 Bot 或 provider cursor 覆盖其他 context。 */
  // 读改写一体；update 返回 undefined 即删除该 botId。
  async updateContext(
    botId: string,
    update: (current: BotContextState | undefined) => BotContextState | undefined,
  ): Promise<BotContextState | undefined> {
    const path = join(this.configDir, BOTS_STATE_FILE);
    return withFileLock(path, async () => {
      // 锁内重新读盘而不是复用调用方内存副本：并发 update 各自基于最新状态计算，才不会互相覆盖。
      const state = await this.readStateUnlocked(path);
  // 先算 next 再决定写入还是删除，避免中间态落盘。
      const next = update(state.bots[botId]);
  // 返回值语义见 INV-04。
      if (next) state.bots[botId] = next;
      else delete state.bots[botId];
  // 写前整体校验，防止单个字段越界污染整个状态文件。
      const parsed = botsStateFileSchema.parse(state);
      // 落盘与返回值共用同一份 parsed：调用方拿到的 context 与磁盘内容因此不会出现两套值。
      await writeJson(path, parsed);
      return parsed.bots[botId];
    });
  }

  // 全量覆盖写；与 updateContext 共用同一把锁。
  async writeState(state: BotsStateFile): Promise<BotsStateFile> {
    // 整份覆盖同样先过 schema：手工拼装的 state 若缺 version 或带未知字段，会在这里被拦下而不是污染文件。
    const parsed = botsStateFileSchema.parse(state);
    const path = join(this.configDir, BOTS_STATE_FILE);
    // withFileLock 与 readState 用同一路径，跨方法的读改写因此串行，不会看到别人写了一半的覆盖结果。
    await withFileLock(path, () => writeJson(path, parsed));
    return parsed;
  }
}
