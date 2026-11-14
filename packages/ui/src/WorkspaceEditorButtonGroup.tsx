// INV-01 未选中编辑器时整组不渲染：守住位置 末尾返回空；改错故障：空按钮会让用户点了没反应。
// INV-02 server 目标不提供本地打开：守住位置 remoteTarget 判断；改错故障：远程工作区会把路径交给本地 IDE。
// INV-03 已安装列表只在挂载时拉取一次：守住位置 effect 空依赖；改错故障：每次选择都重拉会让菜单闪烁。
// INV-04 卸载后禁止写入异步结果：守住位置 disposed 标记；改错故障：迟到响应会设置已卸载组件的状态。
// INV-05 拉取失败只告警不重试：守住位置 catch 分支；改错故障：反复重试会放大后台日志。
// INV-06 office 模式过滤掉非文件管理器目标：守住位置 选择解析入参；改错故障：文档模式会列出只能开文件夹的应用。
// INV-07 选择解析集中在纯函数：守住位置 useMemo 调用；改错故障：分散判断会让按钮与菜单选中态不一致。
// INV-08 已持久化的编辑器优先：守住位置 selectedEditorId 初值；改错故障：每次渲染都读存储会忽略用户刚选的值。
// INV-09 显式选择才持久化：守住位置 shouldPersist 判断；改错故障：程序化回落也会覆盖用户偏好。
// INV-10 打开失败只记录不阻断：守住位置 then 分支；改错故障：抛错会让未处理的 Promise 拒绝。
// INV-11 打开参数按远程身份组装：守住位置 openOptions 计算；改错故障：缺工作区身份会让远程打开定位错目录。
// INV-12 远程目标需要转换后才能下发：守住位置 转换函数调用；改错故障：直传原始对象会丢失序列化字段。
// INV-13 禁用原因同时作用于两个按钮：守住位置 disabled 与 title；改错故障：只禁用主按钮仍可从菜单打开。
// INV-14 禁用时不再写入选择：守住位置 handleOpenEditor 首行；改错故障：禁用点击也会改偏好。
// INV-15 菜单值来自可用编辑器集合：守住位置 单选组取值；改错故障：已卸载的编辑器仍显示为选中。
// INV-16 Windows 图标单独缩小一号：守住位置 平台判定；改错故障：统一尺寸会让按钮偏挤或过小。
// INV-17 回调只在选中项变化时上报：守住位置 effect 依赖；改错故障：每帧上报会让父组件持续重渲染。
// INV-18 两个图标尺寸走记忆化常量：守住位置 useMemo；改错故障：每次渲染新建字符串会打断子组件浅比较。
//
// 模块职责：工作区标题栏的「在编辑器中打开」按钮组，含主按钮与编辑器下拉。
// 状态所有权：已安装列表与本组件选择态归此处；持久化偏好归 editorPreference。
// 阅读顺序：先看挂载拉取与选择解析，再看打开流程与持久化条件，最后看禁用与菜单渲染。
import { createOpenInEditorRemoteTarget, type EditorInfo, type RemoteTarget } from "@zcode/shared";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId, readLastSelectedEditorId } from "@/lib/editorPreference.js";
import {
  resolveWorkspaceEditorSelection,
  shouldPersistWorkspaceEditorSelection,
} from "@/lib/workspaceEditorSelection.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { isFileManagerOpenTarget } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

export function WorkspaceEditorButtonGroup({
  disabledReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  onSelectedEditorChange,
}: {
  disabledReason?: string;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  remoteTarget?: RemoteTarget;
  onSelectedEditorChange?: (editor: EditorInfo | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();

  // installedEditors 是唯一数据源，初始 [] 让首帧直接 return null，不会闪出一个不可点的按钮；
  // selectedEditorId 用惰性初始化器读 readLastSelectedEditorId()，只在挂载时读一次存储，之后由 setSelectedEditorId 掌管；
  // 存储里的 id 可能指向已卸载的编辑器，这里不做校验，交给 resolveWorkspaceEditorSelection 回落。
  const [installedEditors, setInstalledEditors] = useState<EditorInfo[]>([]);
  const [selectedEditorId, setSelectedEditorId] = useState<string | null>(() =>
    readLastSelectedEditorId(),
  );

  // 该 effect 依赖 [platform]，只在 platform 对象替换时重新 getInstalledEditors()，避免每次选择都重拉导致菜单闪烁；
  // disposed 标记在清理函数里置 true，迟到的 then 结果会被丢弃，不会 setInstalledEditors 到已卸载组件；
  // catch 只 logger.warn 并保留空列表，按钮组因此保持隐藏，不用重试放大后台日志。
  useEffect(() => {
    let disposed = false;

    platform
      .getInstalledEditors()
      .then((editors) => {
        if (disposed) {
          return;
        }

        setInstalledEditors(editors);
      })
      .catch((error) => {
        logger.warn("[WorkspaceEditorButtonGroup] 获取已安装 IDE 列表失败:", error);
      });

    return () => {
      disposed = true;
    };
  }, [platform]);

  // availableEditors/selectedEditor 由 resolveWorkspaceEditorSelection 一次算出：office 模式下先用
  // isFileManagerOpenTarget 过滤 installedEditors，再连同 selectedEditorId/remoteTarget 一起传入；
  // 依赖必须含 isOfficeMode 与 remoteTarget，过滤集合或远程可用性变化时按钮、菜单、回调三处才能同步。
  const { availableEditors, selectedEditor } = useMemo(
    () =>
      resolveWorkspaceEditorSelection({
        installedEditors: isOfficeMode
          ? installedEditors.filter(isFileManagerOpenTarget)
          : installedEditors,
        selectedEditorId,
        remoteTarget,
      }),
    [installedEditors, isOfficeMode, remoteTarget, selectedEditorId],
  );

  useEffect(() => {
    onSelectedEditorChange?.(selectedEditor);
  }, [onSelectedEditorChange, selectedEditor]);
  const editorIconClassName = useMemo(() => {
    // Windows 上编辑器图标的视觉占比普遍更大，继续用 size-6 会让按钮显得偏挤。
    // 这里只在当前按钮做平台级微调，不影响菜单里的通用图标尺寸。
    if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) {
      return "size-4 shrink-0";
    }

    return "size-5 shrink-0";
  }, []);
  const editorMenuIconClassName = useMemo(() => {
    if (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)) {
      return "size-4 shrink-0";
    }

    return "size-5 shrink-0";
  }, []);

  // handleOpenEditor 的顺序不可交换：disabledReason 存在时先 return，避免禁用态仍写 setSelectedEditorId；
  // 然后 setSelectedEditorId 让按钮/菜单立即响应，只有 shouldPersistWorkspaceEditorSelection("explicit") 为真才
  // persistLastSelectedEditorId，防止程序化回落覆盖用户偏好；openOptions 仅在 remoteTarget 或 workspaceIdentity 存在时组装；
  // platform.openInEditor 的 rejection 不向界面抛，失败只 logger.warn 记录 editorId/workspaceAbsPath。
  const handleOpenEditor = (editor: EditorInfo) => {
    if (disabledReason) {
      return;
    }
    setSelectedEditorId(editor.id);
    if (shouldPersistWorkspaceEditorSelection("explicit")) {
      persistLastSelectedEditorId(editor.id);
    }
    const openOptions =
      remoteTarget || workspaceIdentity
        ? {
            remoteTarget: remoteTarget ? createOpenInEditorRemoteTarget(remoteTarget) : undefined,
            workspaceIdentity,
          }
        : undefined;

    void platform.openInEditor(editor.id, workspaceAbsPath, openOptions).then((result) => {
      if (result.success) {
        return;
      }
      logger.warn("[WorkspaceEditorButtonGroup] 打开编辑器失败", {
        editorId: editor.id,
        workspaceAbsPath,
        workspaceIdentity,
        error: result.error ?? "unknown-error",
      });
    });
  };

  // selectedEditor 为空（没有可用编辑器）或 remoteTarget.kind === "server" 时整组 return null：
  // server 目标不支持本地打开，继续渲染会把工作区路径交给本机 IDE；
  // 判断放在所有 Hook 之后，保证条件返回不会改变 Hook 调用顺序，父布局高度也不受影响。
  if (!selectedEditor || remoteTarget?.kind === "server") {
    return null;
  }

  return (
    // 主按钮直接打开 selectedEditor；DropdownMenuRadioGroup 的 value 也取 selectedEditor.id，
    // onValueChange 用 availableEditors.find 找回完整 EditorInfo 再复用 handleOpenEditor，
    // 找不到（例如列表刚刷新）时直接 return，避免把未知 id 传给 platform.openInEditor。
    <div className="flex items-center h-7 rounded-lg border border-border bg-input overflow-hidden p-0 hover:border-border-hover">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className="size-7 rounded-none border-0"
        disabled={Boolean(disabledReason)}
        onClick={() => handleOpenEditor(selectedEditor)}
        aria-label={intl.formatMessage(
          { id: "appHeader.openInEditor" },
          { editor: selectedEditor.name },
        )}
        title={
          disabledReason ??
          intl.formatMessage({ id: "appHeader.openInEditor" }, { editor: selectedEditor.name })
        }
      >
        <img
          src={selectedEditor.iconDataUrl}
          alt={selectedEditor.name}
          className={editorIconClassName}
        />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="rounded-none border-0 text-foreground-subtlest !w-5"
            disabled={Boolean(disabledReason)}
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={disabledReason ?? intl.formatMessage({ id: "appHeader.selectOpenApp" })}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuRadioGroup
            value={selectedEditor.id}
            onValueChange={(editorId) => {
              const editor = availableEditors.find((candidate) => candidate.id === editorId);
              if (!editor) {
                return;
              }

              handleOpenEditor(editor);
            }}
          >
            {availableEditors.map((editor) => (
              <DropdownMenuRadioItem key={editor.id} value={editor.id}>
                <img
                  src={editor.iconDataUrl}
                  alt={editor.name}
                  className={editorMenuIconClassName}
                />
                {editor.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
