// INV-01 草稿与作用域同生共死：守住位置 作用域比较；改错故障 切换供应方沿用旧意图。
// INV-02 代次用于丢弃过期恢复：守住位置 自增引用；改错故障 迟到结果覆盖新编辑。
// INV-03 解析函数走引用读取：守住位置 ref 赋值；改错故障 闭包固定旧解析器。
// INV-04 解析缺失即抛错：守住位置 空值检查；改错故障 提交出半份配置。
// INV-05 推荐开关默认开启：守住位置 不等于判断；改错故障 用户默认拿到空配置。
// INV-06 原始模型标识按开关推导：守住位置 双条件；改错故障 关闭推荐后仍请求基线。
// INV-07 解析结果为空时按现状退回：守住位置 早退分支；改错故障 覆盖用户已有配置。
// INV-08 标识未变则不重建模型：守住位置 标识比较；改错故障 每次输入都丢继承配置。
// INV-09 草稿投影以当前模型为准：守住位置 投影调用；改错故障 表单出现未定义字段。
// INV-10 每次修改都推进代次：守住位置 修改入口；改错故障 恢复覆盖用户手改。
// INV-11 重置同时取消请求：守住位置 重置分支；改错故障 旧响应写入新表单。
// INV-12 恢复前检查标识与解析器：守住位置 双条件早退；改错故障 空标识发起无意义请求。
// INV-13 恢复结果只在代次未变时应用：守住位置 回调判断；改错故障 恢复结果写错供应方。
// INV-14 提交前推进代次：守住位置 提交入口；改错故障 并发恢复覆盖提交。
// INV-15 仅在需要时等待基线：守住位置 布尔条件；改错故障 每次保存都阻塞。
// INV-16 待定态只在有解析器时成立：守住位置 表达式；改错故障 永久显示加载中。
// INV-17 覆盖项与继承配置同步返回：守住位置 返回字段；改错故障 保存时丢失继承。
// INV-18 暴露的动作集合固定：守住位置 返回对象；改错故障 调用方依赖内部状态。
//
// 模块职责：添加与编辑模型共用的草稿状态、推荐基线与提交流程。
// 状态所有权：草稿、作用域与编辑代次在 hook 内，基线解析交给独立 hook。
// 阅读顺序：先看作用域纠正，再看推荐推导，最后看重置、恢复与提交。
import { useCallback, useRef, useState } from "react";
import type { ModelConfigObject, ModelConfigResolution } from "@zcode/provider";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import {
  modelDraftOverrides,
  projectModelDraft,
  updateModelDraft,
  restoreModelDraft,
} from "@/settings/model-provider-section/ProviderModelDraftState.js";
import { useModelConfigResolution } from "@/settings/model-provider-section/useModelConfigResolution.js";

/** 添加和编辑共享推荐生命周期；业务入口仅保留初始化、权限与各自的保存事务。 */
// useProviderModelDraft() 把评分与推荐生命周期收在同一处。
// useProviderModelDraft() 的业务入口只保留初始化、权限与各自的保存事务。
// resolve 参数可选，缺省时 useModelConfigResolution() 的 enabled 走 false。
// scopeKey 变化代表切换供应方，draftScope 比较即触发重建。
// editGeneration 用自增代次丢弃过期的 restore() 结果。
export function useProviderModelDraft({
  model,
  open,
  scopeKey,
  resolve,
}: {
  model: ProviderSettingsFormModel;
  open: boolean;
  scopeKey: string;
  resolve?: (modelId: string, personalConfig: ModelConfigObject) => Promise<ModelConfigResolution>;
}) {
  const [rawDraft, setRawDraft] = useState(() => createProviderModelDraftValues(model));
  const [draftScope, setDraftScope] = useState(scopeKey);
  const editGeneration = useRef(0);
  // draftScope !== scopeKey 时立刻重建草稿。
  // 旧代次不显式作废，比较 editGeneration.current 即可。
  // draftScope 的纠正写在渲染期，避免先渲染一帧旧草稿。
  // resolveRef.current 每次渲染刷新，闭包不固定旧解析器。
  if (draftScope !== scopeKey) {
    // 切换供应商必须同时丢弃旧草稿和旧请求，不能把上一供应商的用户意图带到新目标。
    setDraftScope(scopeKey);
    setRawDraft(createProviderModelDraftValues(model));
  }
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  const resolveRecommended = useCallback(
    (id: string) => {
      if (!resolveRef.current) throw new Error("Model Config Resolution 未配置");
      // 公共草稿持有个人意图；只向 Host 取推荐基线，不用半有效表单拼装第二份 Overlay。
      return resolveRef.current(id, {});
    },
    [scopeKey],
  );
  const smart = rawDraft.useRecommendedConfigValue !== false;
  const originalModelId =
    model.useRecommendedConfig !== false && !rawDraft.clearPersonalConfigValue
      ? model.modelId
      : undefined;
  const config = useModelConfigResolution({
    open,
    enabled: smart,
    modelId: rawDraft.idValue,
    originalModelId,
    resolve: resolve ? resolveRecommended : undefined,
  });
  const modelWithResolution = (
    resolution: ModelConfigResolution | null | undefined,
  ): ProviderSettingsFormModel => {
    if (resolution)
      return {
        ...model,
        inheritedConfig: resolution.inheritedConfig,
        config: resolution.inheritedConfig,
      };
    if (rawDraft.idValue.trim() === model.modelId) return model;
    return { ...model, config: {}, inheritedConfig: undefined };
  };
  const currentModel = modelWithResolution(config.resolution);
  const draft = projectModelDraft(rawDraft, currentModel);
  const change = (patch: Partial<ProviderModelDraftValues>) => {
    editGeneration.current += 1;
    setRawDraft(updateModelDraft(draft, patch, currentModel));
  };
  const reset = (nextModel: ProviderSettingsFormModel) => {
    editGeneration.current += 1;
    config.cancel();
    setRawDraft(createProviderModelDraftValues(nextModel));
  };
  const restore = async () => {
    const generation = ++editGeneration.current;
    const apply = (resolvedModel: ProviderSettingsFormModel) =>
      setRawDraft(restoreModelDraft(draft, resolvedModel));
    if (!draft.idValue.trim() || !resolve) {
      config.cancel();
      apply(currentModel);
      return;
    }
    await config.restore({
      isCurrent: () => editGeneration.current === generation,
      apply: (resolution) => apply(modelWithResolution(resolution)),
    });
  };
  // commit() 先自增 editGeneration.current，作废进行中的 restore()。
  // requiresResolution 为真时才 await config.flush()。
  // resolution 仍为空就抛错，不写入半份配置。
  // resolveProviderModelDraftCommit() 用草稿与 resolvedModel 合成提交内容。
  const commit = async () => {
    editGeneration.current += 1;
    const requiresResolution = smart && resolve && rawDraft.idValue.trim() !== originalModelId;
    const resolution = requiresResolution
      ? (config.resolution ?? (await config.flush()))
      : config.resolution;
    if (requiresResolution && !resolution) throw new Error("Model Config Resolution 尚未就绪");
    const resolvedModel = modelWithResolution(resolution);
    return resolveProviderModelDraftCommit({
      currentModel: resolvedModel,
      draft: projectModelDraft(rawDraft, resolvedModel),
    });
  };
  return {
    draft,
    change,
    reset,
    restore,
    commit,
    overrides: modelDraftOverrides(draft),
    inheritedConfig: currentModel.inheritedConfig,
    pending:
      smart &&
      Boolean(resolve) &&
      rawDraft.idValue.trim() !== originalModelId &&
      !config.resolution,
    defaultsLoaded: smart && config.defaultsLoaded,
    flush: config.flush,
    cancel: config.cancel,
  };
}
