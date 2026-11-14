// INV-01 草稿与配置分离：守住位置 localDataBaseDir；改错故障 每次输入被外部值覆盖。
// INV-02 空配置回落默认目录：守住位置 effectiveDir；改错故障 输入框为空。
// INV-03 浏览只改草稿：守住位置 handleBrowseDataBaseDir；改错故障 选目录即触发迁移。
// INV-04 保存才执行迁移：守住位置 handleSave；改错故障 迁移与浏览混在一起。
// INV-05 默认目录存为空串：守住位置 newValue；改错故障 默认值被持久化。
// INV-06 保存中禁用交互：守住位置 isSaving；改错故障 重复点击并发迁移。
// INV-07 浏览中禁用交互：守住位置 isPickingDataBaseDir；改错故障 重复打开弹窗。
// INV-08 非脏值不可保存：守住位置 isDirty；改错故障 空提交覆盖配置。
// INV-09 保存成功保留草稿：守住位置 effect 条件；改错故障 保存后立即回退旧值。
// INV-10 保存失败恢复可编辑：守住位置 error 状态；改错故障 无法重试。
// INV-11 错误文案按类型选择：守住位置 错误判断；改错故障 安装目录错误被报成复制失败。
// INV-12 输入框只读：守住位置 readOnly；改错故障 手输任意路径。
// INV-13 保存成功提示需重启：守住位置 saved 分支；改错故障 用户不知道要重启。
// INV-14 状态提示带测试标识：守住位置 data-testid；改错故障 端到端无法断言状态。
// INV-15 按钮文案国际化：守住位置 formatMessage；改错故障 中文硬编码透出。
// INV-16 选择取消不报错：守住位置 空值早退；改错故障 取消被当成失败。
// INV-17 组件不直接调用平台：守住位置 props 回调；改错故障 测试无法注入。
// INV-18 依赖数组完整：守住位置 useCallback；改错故障 闭包捕获旧值。
//
// 模块职责：数据目录设置控件，负责草稿编辑、目录选择与保存迁移。
// 状态所有权：配置归父级；草稿、忙碌与保存状态为组件局部态。
// 阅读顺序：先看草稿同步，再看浏览与保存回调，最后看状态提示渲染。
import { FolderOpen, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { isDataBaseDirForbiddenWindowsInstallDirError } from "@zcode/shared";
import {
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DataBaseDirControl({
  dataBaseDir,
  defaultHomeDir,
  onDataBaseDirChange,
  onSelectDataBaseDir,
}: {
  dataBaseDir: string;
  defaultHomeDir: string;
  onDataBaseDirChange: (dir: string) => Promise<void>;
  onSelectDataBaseDir: () => Promise<string | null>;
}) {
  const { intl } = useZCodeIntl();
  // dataBaseDir 为空串时回落到 defaultHomeDir，输入框始终有值可显示。
  // effectiveDir 是输入框初值与外部同步的唯一来源。
  // effectiveDir 只做展示回落，不写回 dataBaseDir 配置。
  const effectiveDir = dataBaseDir || defaultHomeDir;
  // localDataBaseDir 是草稿值，用户输入不直接改 dataBaseDir。
  // 浏览目录只更新草稿，迁移要等 handleSave 调 onDataBaseDirChange。
  // 保存成功后 saveState 变为 "saved"，草稿与外部值对齐。
  // isDirty 由 localDataBaseDir 与 effectiveDir 比较得出，不单独存状态。
  const [localDataBaseDir, setLocalDataBaseDir] = useState(effectiveDir);
  const [isPickingDataBaseDir, setIsPickingDataBaseDir] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMessageId, setErrorMessageId] = useState("settings.dataBaseDirCopyFailed");

  // saveState !== "saved" 时把 localDataBaseDir 同步为 effectiveDir。
  // saveState === "saved" 的那一轮保留草稿，避免刚写入的值被回读覆盖。
  // 依赖数组只有 effectiveDir 与 saveState，其余值变化不触发同步。
  useEffect(() => {
    if (saveState !== "saved") {
      setLocalDataBaseDir(effectiveDir);
    }
  }, [effectiveDir, saveState]);

  const isDirty = localDataBaseDir.trim() !== effectiveDir;
  const isSaving = saveState === "saving";

  // onSelectDataBaseDir 返回系统弹窗选中的真实目录，取消时为 null。
  // 取消选择直接 return，草稿与 saveState 都不变。
  // 选中后写入草稿并把 saveState 复位为 "idle"，清掉上次错误。
  // 忙碌标记在 finally 复位。
  const handleBrowseDataBaseDir = useCallback(async () => {
    setIsPickingDataBaseDir(true);
    try {
      const selectedDir = await onSelectDataBaseDir();
      if (!selectedDir) {
        return;
      }

      // 之前这里允许手输任意字符串，用户填错路径后仍会触发整份数据复制。
      // 这里改成只接受系统目录弹窗返回的真实文件夹路径，先更新草稿值，再由“保存”统一触发迁移，
      // 避免把“浏览目录”和“执行数据迁移”这两个风险不同的动作混在一起。
      setLocalDataBaseDir(selectedDir);
      if (saveState !== "idle") {
        setSaveState("idle");
      }
    } finally {
      setIsPickingDataBaseDir(false);
    }
  }, [onSelectDataBaseDir, saveState]);

  // trimmed === defaultHomeDir 时 newValue 写空串，其余情况写真实路径。
  // saveState 置 "saving" 后输入框与按钮在渲染层禁用。
  // 失败时按错误类型选 errorMessageId，文案取自 settings.dataBaseDir*。
  const handleSave = useCallback(async () => {
    const trimmed = localDataBaseDir.trim();
    const newValue = trimmed === defaultHomeDir ? "" : trimmed;
    setSaveState("saving");
    try {
      await onDataBaseDirChange(newValue);
      setSaveState("saved");
    } catch (error) {
      setErrorMessageId(
        isDataBaseDirForbiddenWindowsInstallDirError(error)
          ? "settings.dataBaseDirForbiddenInstallDir"
          : "settings.dataBaseDirCopyFailed",
      );
      setSaveState("error");
    }
  }, [defaultHomeDir, localDataBaseDir, onDataBaseDirChange]);

  return (
    <div className="flex w-[320px] min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
        <Input
          size="lg"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_INPUT}
          value={localDataBaseDir}
          readOnly
          disabled={isSaving || isPickingDataBaseDir}
          placeholder={intl.formatMessage({ id: "settings.dataBaseDirPlaceholder" })}
          className="flex-1 font-mono"
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_BROWSE}
          disabled={isSaving || isPickingDataBaseDir}
          onClick={() => void handleBrowseDataBaseDir()}
        >
          {intl.formatMessage({ id: "settings.dataBaseDirBrowse" })}
        </Button>
        <Button
          type="button"
          size="sm"
          data-testid={TID_SETTINGS_DATA_BASE_DIR_SAVE}
          disabled={!isDirty || isSaving || isPickingDataBaseDir}
          onClick={() => void handleSave()}
        >
          {isSaving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            intl.formatMessage({ id: "settings.dataBaseDirSave" })
          )}
        </Button>
      </div>
      {saveState === "saving" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saving"
          className="text-ui-base text-foreground-subtle"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirCopying" })}
        </p>
      ) : saveState === "saved" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="saved"
          className="text-ui-base text-amber-600 dark:text-amber-400"
        >
          {intl.formatMessage({ id: "settings.dataBaseDirRestartRequired" })}
        </p>
      ) : saveState === "error" ? (
        <p
          data-testid={TID_SETTINGS_DATA_BASE_DIR_STATUS}
          data-state="error"
          className="text-ui-base text-destructive"
        >
          {intl.formatMessage({ id: errorMessageId })}
        </p>
      ) : null}
    </div>
  );
}
