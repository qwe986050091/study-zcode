// INV-01 操作按来源去重：守住位置 marketplace:add: 前缀拼接；改错故障 同一来源并发添加两次。
// INV-02 空来源不可提交：守住位置 trimmedSource 判断；改错故障 空字符串被提交到后端。
// INV-03 提交防重入：守住位置 pendingRef；改错故障 回写前重复发起同一请求。
// INV-04 成功才清空并关闭：守住位置 added 分支；改错故障 同一市场源被重复添加。
// INV-05 失败保留输入与弹层：守住位置 无 else 分支；改错故障 用户需重输整段地址。
// INV-06 拖放仅桌面可用：守住位置 canPickPath；改错故障 Web 端拖入文件无响应。
// INV-07 目录选择仅桌面可用：守住位置 按钮条件渲染；改错故障 Web 端点击无反应。
// INV-08 拖入只取首个文件：守住位置 files 下标访问；改错故障 多文件拖入行为不确定。
// INV-09 取不到路径则忽略：守住位置 path 判断；改错故障 空路径覆盖已有输入。
// INV-10 拖离按容器判断：守住位置 contains 检查；改错故障 拖过子元素就丢高亮。
// INV-11 输入法组合态不提交：守住位置 isImeComposingKeyEvent；改错故障 候选确认误触发添加。
// INV-12 组合态用 ref 兜底：守住位置 compositionActiveRef；改错故障 组合标志提前翻假时误提交。
// INV-13 仅 Enter 触发提交：守住位置 键值判断；改错故障 任意按键都尝试添加。
// INV-14 提交前阻止默认行为：守住位置 preventDefault；改错故障 弹窗重复响应提交。
// INV-15 错误提示可滚动：守住位置 错误块高度与溢出；改错故障 长错误撑破弹窗。
// INV-16 弹窗宽度有上限：守住位置 min 宽度表达式；改错故障 窄屏横向溢出。
// INV-17 添加中禁用提交：守住位置 adding 判断；改错故障 添加过程中可再次点击。
// INV-18 本组件不发请求：守住位置 回调注入；改错故障 组件直接依赖数据层。
//
// 模块职责：添加插件市场源弹窗，支持地址输入、拖放与目录选择。
// 状态所有权：输入、拖拽高亮与组合态为本组件局部；添加进度来自外部操作表。
// 阅读顺序：先看三个入口处理器，再读提交防重入，最后看弹窗结构与按钮。
import { useRef, useState, type DragEvent } from "react";
import { FolderOpen, Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";

/**
 * 顶栏 New 直接打开添加市场源对话框：收编原 AddMarketplacePopover 的
 * github/git/URL/本地路径（含拖放与目录选择）能力，零后端新增。
 */
export function AddMarketplaceSourceDialog({
  open,
  onOpenChange,
  onAddMarketplace,
  activeOperations,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddMarketplace: (source: string) => Promise<boolean>;
  activeOperations: ReadonlyArray<{ id: string }>;
  error?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  // 仅桌面端能把拖拽 File / 目录选择框解析成 agent 可访问的本地绝对路径；Web 端隐藏这些入口。
  const canPickPath = platform?.canSelectFilePath ?? false;
  const [source, setSource] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const trimmedSource = source.trim();
  const adding = activeOperations.some(
    (operation) => operation.id === `marketplace:add:${trimmedSource}`,
  );
  // 本地输入法 composition 态：部分平台 isComposing 会提前翻 false，靠 ref 兜底，避免候选确认误触发添加。
  const compositionActiveRef = useRef(false);
  // 防重复提交：Enter 与点击共用，避免 store 回写前的窗口里重复发起同一来源的添加。
  const pendingRef = useRef(false);

  // trimmedSource 为空时 handleAdd 直接 return，不提交空来源。
  // pendingRef.current 为真说明提交在途，重复 Enter 直接返回。
  // 通过检查后立即置 pendingRef.current 为真，占住防重入窗口。
  // added 为真才 setSource 清空输入框。
  // 同一分支内 onOpenChange(false) 关闭弹窗，失败时弹层保留。
  // finally 无条件复位 pendingRef.current，异常路径也释放标记。
  const handleAdd = async () => {
    if (trimmedSource.length === 0 || pendingRef.current) return;
    pendingRef.current = true;
    try {
      const added = await onAddMarketplace(trimmedSource);
      // 失败时保留输入与弹层，让用户结合上方错误提示修正来源后重试。
      if (added) {
        setSource("");
        onOpenChange(false);
      }
    } finally {
      pendingRef.current = false;
    }
  };

  // platform 为空时 handleChooseDirectory 直接返回，Web 端没有目录选择。
  // selectDirectory 返回空串时保留 source 原值，不清空已有输入。
  // 取消与异常都落进 catch 分支，不向用户弹二次错误。
  // 该分支不写 error，错误提示仍由外部 error 属性控制。
  // 目录选择不改弹层开关，open 仍由调用方持有。
  const handleChooseDirectory = async () => {
    if (!platform) return;
    try {
      const dir = await platform.selectDirectory();
      if (dir) setSource(dir);
    } catch {
      // 取消或对话框异常时静默：保留当前输入，不打断添加流程。
    }
  };

  // handleDrop 先 event.preventDefault()，阻止浏览器把文件当导航打开。
  // 落下立即 setDragActive(false)，不依赖 dragleave 收尾。
  // dataTransfer.files[0] 只取首个文件，多文件拖入其余忽略。
  // file 为空时直接 return，避免读 undefined 上的路径。
  // getPathForFile 返回非空 path 才 setSource 覆盖输入。
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const path = platform?.getPathForFile?.(file)?.trim();
    if (path) setSource(path);
  };

  // Dialog 的 open 受控于 props，onOpenChange 原样上抛。
  // 拖放三个处理器只在 canPickPath 为真时挂载，Web 端为 undefined。
  // Input 用 autoFocus 自动聚焦，减少一次点击。
  // 目录按钮按 canPickPath 条件渲染，Web 端不出现该入口。
  // 提交按钮按 adding 切换 Loader2 图标，禁用条件同时看空输入。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="plugin-store-add-source-dialog"
        className={cn(
          "w-[min(420px,calc(100vw-2rem))] max-w-none transition-colors",
          canPickPath && dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
        onDragOver={
          canPickPath
            ? (event) => {
                event.preventDefault();
                setDragActive(true);
              }
            : undefined
        }
        onDragLeave={
          canPickPath
            ? (event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDragActive(false);
                }
              }
            : undefined
        }
        onDrop={canPickPath ? handleDrop : undefined}
      >
        <DialogTitle className="text-ui-lg font-medium text-foreground">
          {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
        </DialogTitle>
        {error ? (
          <div
            className="max-h-[min(240px,40vh)] min-w-0 overflow-y-auto rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base whitespace-pre-wrap break-words text-destructive"
            data-testid="plugin-store-add-source-error"
            role="alert"
          >
            {error}
          </div>
        ) : null}
        <Input
          type="text"
          data-testid="plugin-store-add-source-input"
          size="lg"
          autoFocus
          aria-label={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          onCompositionStart={() => {
            compositionActiveRef.current = true;
          }}
          onCompositionEnd={() => {
            compositionActiveRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            if (
              isImeComposingKeyEvent({
                compositionActive: compositionActiveRef.current,
                nativeEvent: event.nativeEvent,
              })
            ) {
              return;
            }
            event.preventDefault();
            void handleAdd();
          }}
          placeholder={intl.formatMessage({ id: "settings.plugins.marketplaces.source" })}
        />
        {canPickPath ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.plugins.marketplaces.dropHint" })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {canPickPath ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => void handleChooseDirectory()}
            >
              <FolderOpen data-icon="inline-start" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.plugins.marketplaces.chooseDirectory" })}
            </Button>
          ) : null}
          <Button
            type="button"
            data-testid="plugin-store-add-source-submit"
            variant="default"
            size="lg"
            disabled={trimmedSource.length === 0 || adding}
            onClick={() => void handleAdd()}
          >
            {adding ? (
              <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" />
            ) : (
              <Plus data-icon="inline-start" aria-hidden="true" />
            )}
            {intl.formatMessage({ id: "settings.plugins.marketplaces.add" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
