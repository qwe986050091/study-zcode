// 旧版任务会话文件：meta.mode 允许缺失，用于读取 Claude 迁移时被清洗过的历史快照。
import type { ZCodeSessionFile, ZCodeTaskMeta } from "@zcode/shared";
import { zcodeSessionFileSchema, zcodeTaskMetaSchema, zcodeTaskModeSchema } from "@zcode/shared";

// 仅在类型层放宽 mode，其它字段仍沿用当前 schema 的强约束。
export type LegacyTaskSessionFile = Omit<ZCodeSessionFile, "meta"> & {
  meta: Omit<ZCodeTaskMeta, "mode"> & { mode?: ZCodeTaskMeta["mode"] };
};

// 校验规则只把 mode 改为可选，不能顺手放宽其他必需字段。
const legacyTaskSessionFileSchema = zcodeSessionFileSchema.extend({
  // Claude 原生迁移会按清洗路径删除 meta.mode。
  // legacy snapshot 读取/写入仍要校验其它必需字段，但不能再强制把被过滤字段补回文件。
  meta: zcodeTaskMetaSchema.extend({
    mode: zcodeTaskModeSchema.optional(),
  }),
});

export function parseLegacyTaskSessionFile(input: unknown): LegacyTaskSessionFile {
  return legacyTaskSessionFileSchema.parse(input);
}

export function safeParseLegacyTaskSessionFile(input: unknown) {
  return legacyTaskSessionFileSchema.safeParse(input);
}
