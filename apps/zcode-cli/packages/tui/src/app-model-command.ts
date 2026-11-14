// /model 建议面板控制器。
// 职责：维护模型候选目录、按草稿过滤并维护选中态。
// 边界：只管理 UI 候选与选择，不执行模型切换、不写会话配置。
// 副作用：草稿进入 /model 上下文时异步刷新目录；失败被吞掉并保留旧目录。
// 不变量：选择态仅在面板激活且目录非空时存在，空目录期间保留选中意向。

import React from "react";
import {
  filterModelOptions,
  modelCommandQuery,
  reconcileModelCommandSelection,
  selectedModelOption,
} from "./app-input.js";
import type { ModelCommandSelectionState } from "./app-model.js";
import type { TuiModelOption, TuiOptions } from "./types.js";

// /model 建议面板控制器：管理模型目录、过滤与选中态。
// 输入：当前草稿 draft，以及宿主 options 中的初始模型目录/静态列表/远程取数函数；
// listModelOptions 缺失表示未提供远程刷新能力，此时只使用本地目录。
// 输出：过滤后的候选、选中态及其 setter、草稿校正函数、提交时选中项解析、目录 setter。
// 副作用：当草稿进入 /model 上下文时触发一次远程目录刷新（异步、不阻断渲染）；
// 失败被吞掉并保持旧目录，避免面板因网络问题消失。
// 不变量：selection 仅在 active 且目录非空时存在；空目录期间保留用户选中意向，待目录到达后生效。
export function useModelCommandController(
  draft: string,
  options: Pick<TuiOptions, "modelOptions" | "initialResult" | "listModelOptions">,
): {
  filteredOptions: readonly TuiModelOption[];
  reconcileDraft: (value: string) => ModelCommandSelectionState | undefined;
  selectedOption: (submittedValue: string) => TuiModelOption | undefined;
  selection: ModelCommandSelectionState | undefined;
  setSelection: React.Dispatch<React.SetStateAction<ModelCommandSelectionState | undefined>>;
  setModelOptions: React.Dispatch<React.SetStateAction<readonly TuiModelOption[]>>;
} {
  const [modelOptions, setModelOptions] = React.useState<readonly TuiModelOption[]>(
    () => options.initialResult?.modelOptions ?? options.modelOptions ?? [],
  );
  const listModelOptions = options.listModelOptions;
  const [selection, setSelection] = React.useState<ModelCommandSelectionState | undefined>();
  const active = modelCommandQuery(draft) !== undefined;
  React.useEffect(() => {
    if (!active || !listModelOptions) return;
    let cancelled = false;
    void listModelOptions()
      .then((models) => {
        // 草稿已离开 /model 或组件重挂载后丢弃结果，避免旧响应覆盖新目录。
        if (!cancelled) setModelOptions(models);
      })
      // 目录刷新失败不改变现有候选，也不打断输入；/model 仍可用本地列表。
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, listModelOptions]);
  // Opening from an empty catalog must admit selection when the fresh catalog arrives.
  React.useEffect(() => {
    setSelection((current) =>
      active && modelOptions.length > 0 ? (current ?? { selectedIndex: 0 }) : undefined,
    );
  }, [active, modelOptions]);
  // 过滤候选随草稿与目录变化重算；空查询返回完整目录，非 /model 上下文返回空数组。
  const filteredOptions = React.useMemo(
    () => filterModelOptions(draft, modelOptions),
    [draft, modelOptions],
  );
  // 草稿变化后重建选择态：进入 /model 时默认选中第 0 项，离开则置 undefined。
  const reconcileDraft = React.useCallback(
    (value: string) => {
      const nextSelection = reconcileModelCommandSelection(value, modelOptions);
      setSelection(nextSelection);
      return nextSelection;
    },
    [modelOptions],
  );
  // 提交前解析最终选中模型：以过滤后的候选为准，越界下标由底层函数夹取。
  const selectedOption = React.useCallback(
    (submittedValue: string) => selectedModelOption(submittedValue, selection, filteredOptions),
    [filteredOptions, selection],
  );

  return {
    filteredOptions,
    reconcileDraft,
    selectedOption,
    selection,
    setSelection,
    setModelOptions,
  };
}
