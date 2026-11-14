// 0002 迁移：把 automation 的旧三列（model/provider/thought_level）解码为 model_selection。
// 解码规则必须与发布时的旧 parser 完全一致，不能引用会随版本变化的运行时实现。
import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@zcode/shared";

// 冻结 0002 的发布前已裁决编码；不能调用将来可能修改的运行时 parser/身份表。
// 保持与旧 decodeCustomModelValue / parseModelPickerValue 的转义和分隔优先级一致。
// 冻结的旧编码到供应商 ID 映射：只覆盖 migration 0002 发布时已存在的内置供应商。
// 新增映射会改变历史数据解释，必须在新的迁移中处理而不是扩展本表。
const providerNames: Readonly<Record<string, string>> = {
  "builtin:bigmodel": "bigmodel-api",
  "builtin:zai": "zai-api",
  "builtin:bigmodel-start-plan": "account:bigmodel-start-plan",
  "builtin:zai-start-plan": "account:zai-start-plan",
  "builtin:bigmodel-coding-plan": "account:bigmodel-individual-coding-plan",
  "builtin:zai-coding-plan": "account:zai-individual-coding-plan",
};
// URI 解码失败时回退原文：旧数据可能包含未编码字符，不能因此丢弃整行选择。
function decodeComponent(value: string): string {
  try {
    // 解码成功直接返回，与旧 parser 的百分号转义规则保持一致，不能换成自定义实现。
    return decodeURIComponent(value);
  } catch {
    // catch 分支不记日志也不重新编码，返回值与输入保持逐字节一致。
    return value;
  }
}

// 旧三列均为可空文本，解码函数必须在每一处都容忍 null。
interface LegacySelectionRow {
  automation_id: string;
  model: string | null;
  provider: string | null;
  thought_level: string | null;
}

// 旧编码优先级：custom: 前缀 > provider/model 斜杠格式 > 裸 model。
// 任一环节无法确定供应商身份时返回 undefined，由调用方写入 NULL 而不是猜默认值。
function decodeLegacySelection(row: LegacySelectionRow): ModelSelection | undefined {
  // 先 trim 再判空，纯空格的 model 不会被当成有效编码进入解析。
  const value = row.model?.trim();
  // 空模型视为没有选择意图，不能继续走 provider 推断并生成一条虚假记录。
  if (!value) return undefined;
  // ?? 让 null 与 undefined 都变成空串，后面 startsWith 与 includes 才不会抛错。
  let provider = row.provider?.trim() ?? "";
  let model = value;
  let reasoningLevel = row.thought_level?.trim();
// custom: 格式有两种历史变体，先按 builtin 多段形式判定。
  if (value.startsWith("custom:")) {
    const body = value.slice(7);
    // 只取第一个冒号作分隔点，modelId 自身可能仍含冒号。
    const separator = body.indexOf(":");
// custom: 后没有分隔符说明编码损坏，不能退化为裸模型名。
    if (separator < 0) return undefined;
    const parts = body.split(":");
    // 三段以上且首段是 builtin 才按内置多段编码解析，否则按普通 provider:model 处理。
    if (parts.length >= 3 && parts[0] === "builtin") {
      provider = `builtin:${parts[1]}`;
      model = decodeComponent(parts.slice(2).join(":"));
    } else {
      provider = decodeComponent(body.slice(0, separator));
      model = decodeComponent(body.slice(separator + 1));
    }
// 斜杠格式：最后一段可能带 $reasoningLevel 后缀，需在拆分供应商后再剥离。
  // 没有 custom: 前缀时才看斜杠格式，判断顺序反了会把路径样式误当编码格式。
  } else if (value.includes("/")) {
    const separator = value.indexOf("/");
    provider = value.slice(0, separator);
    model = value.slice(separator + 1);
    const levelSeparator = model.indexOf("$");
    // levelSeparator 的两个边界都要判：$ 位于首位或末位只是模型名字符，不是推理等级后缀。
    if (levelSeparator > 0 && levelSeparator < model.length - 1) {
      reasoningLevel = model.slice(levelSeparator + 1).trim();
      if (!reasoningLevel) return undefined;
      model = model.slice(0, levelSeparator);
    }
// glm/zcode 是旧执行后端而非供应商身份，直接判为无法迁移。
  } else if (["glm", "zcode"].includes(provider)) {
    // 旧 provider=glm/zcode 是执行后端，不是供应商身份。
    return undefined;
  }
  provider = provider.trim();
  model = model.trim();
  if (!provider || !model) return undefined;
  const providerId = provider.startsWith("builtin:") ? providerNames[provider] : provider;
  // 未知 builtin 前缀返回 undefined，不能把原始字符串当 providerId 写进新列。
  if (!providerId) return undefined;
  // 只有拿到 reasoningLevel 才挂 options，空对象会覆盖新模型的默认推理语义。
  return { providerId, modelId: model, ...(reasoningLevel ? { options: { reasoningLevel } } : {}) };
}

/**
 * 冻结 0002 的一次转换：运行 Reader 只看新列，旧三列原样保留。
 * 有旧来源允许重建未发布目标值；无法确定身份留 SQL NULL，默认语义写 JSON null。
 * 必须在库级 migration 事务内调用，不得恢复逐次读取导入。
 */
// 批量迁移入口：只扫描 model 非空的行，避免把完全空配置写成 JSON null。
// 必须在库级 IMMEDIATE 事务内调用，读旧值与写新值不能分属两个快照。
// 前置条件：只能由一次性 migration 触发。迁移后旧三列仍原样保留，重跑会按陈旧旧值覆盖用户后来写入的 model_selection。
// 因此不能在每次启动时调用，判重必须依赖 schema_migration 记录而不是「旧列还在」。
export function importLegacyAutomationSelections(db: DatabaseSync): void {
// 一次性读出全部候选行，否则遍历过程中会对同一表反复加读锁。
  const rows = db
    .prepare(
      "SELECT automation_id, model, provider, thought_level FROM automations WHERE model IS NOT NULL",
    )
    .all() as unknown as LegacySelectionRow[];
// 逐行解码；UPDATE 的 WHERE 复用旧值做乐观校验，防止并发修改被覆盖。
  // 逐行解码后立即写回，不在内存里攒批次，单行失败必须只影响该行。
  for (const row of rows) {
    const decoded = decodeLegacySelection(row);
    // decoded 为空时只有该行确有 model 值才写 SQL NULL，空配置留给末尾统一处理。
    if (!decoded) {
      // 有旧显式意图但无法确定身份，不保留未发布中间态的“默认”，避免静默换模型。
      if (row.model?.trim())
        db.prepare("UPDATE automations SET model_selection=NULL WHERE automation_id=?").run(
          row.automation_id,
        );
      continue;
    }
    // 外层 IMMEDIATE 事务保证旧来源和写入同一快照；旧列/时间戳都不修改。
    // 三列都用 IS 而非 = 比较，NULL 才能参与匹配，否则 provider 为空的行永远不会被更新。
    db.prepare(
      `UPDATE automations SET model_selection = ?
       WHERE automation_id = ?
         AND model IS ? AND provider IS ? AND thought_level IS ?`,
    ).run(JSON.stringify(decoded), row.automation_id, row.model, row.provider, row.thought_level);
  }
  // 最后把空配置行统一写成 JSON null，SQL NULL 与字符串 null 的语义必须区分。
  db.exec(`UPDATE automations SET model_selection='null'
    WHERE model_selection IS NULL AND (model IS NULL OR trim(model)='')`);
}
