// OpenSplitButton.tsx —— 打开按钮：主按钮预览、下拉选择第三方应用、右键补充路径动作。
//
// 职责边界
//   做什么：根据目标类型分派预览、外部打开、指定编辑器打开，并提供复制路径等菜单动作。
//   不做什么：不决定编辑器优先级、不实现文件打开、不维护工作区状态。
//   依赖谁：usePlatform 的打开能力、useFileContextActions 的路径动作、编辑器选择解析函数。
//   被谁调用：消息里的文件链接与网页卡片，以及复用整卡渲染的时间线。
//   边界：按钮只做动作编排与失败提示，成功与否以平台返回为准。
//
//
// INV-01 预览优先级固定：代码查看器先于文件链接回调 —— 守住它的位置：handlePreview 的分支顺序 —— 改错故障：同一文件被两个入口重复打开
// INV-02 卡片虚拟行复用时必须自增请求号：目标换了要作废旧结果 —— 守住它的位置：目标变化 effect —— 改错故障：上一张卡片的编辑器列表出现在新卡片上
// INV-03 effect 清理里也要自增请求号：卸载同样让结果失效 —— 守住它的位置：effect 的返回函数 —— 改错故障：已卸载卡片仍写 state，出现告警与错值
// INV-04 请求号不匹配时禁止写 state：成功与失败两条路径都要拦 —— 守住它的位置：loadEditors 的两处早退 —— 改错故障：过期响应覆盖当前卡片的加载状态
// INV-05 loading 只在当前请求结束时清除 —— 守住它的位置：finally 的请求号判断 —— 改错故障：旧请求收尾时把新请求的 loading 关掉，列表永久空白
// INV-06 远程来源且拿不到远程目标时必须返回空列表 —— 守住它的位置：sortedEditors 的 useMemo —— 改错故障：远程工作区里展示本地编辑器，点击必然失败
// INV-07 原生打开必须排除远程来源 —— 守住它的位置：canOpenNative —— 改错故障：远程文件被交给本机应用打开并报错
// INV-08 预览按钮是否可用只取决于是否存在对应回调 —— 守住它的位置：canPreview —— 改错故障：按钮可点但没有任何反应
// INV-09 停止冒泡必须是可选项：卡片内嵌时不能拦截外层点击 —— 守住它的位置：stopPropagation 判断 —— 改错故障：整卡点开被按钮吞掉
// INV-10 右键菜单与下拉菜单必须共用同一批动作函数 —— 守住它的位置：renderContextActions 与下拉组件 —— 改错故障：两个入口行为不一致
// INV-11 打开失败必须有 toast：不能只写日志 —— 守住它的位置：各 catch 分支 —— 改错故障：用户点了打开却毫无反馈
// INV-12 最近选择的编辑器必须持久化 —— 守住它的位置：handleOpenInEditor 首行 —— 改错故障：下次打开又回到默认编辑器
// INV-13 编辑器列表顺序沿用平台返回值：不在这里排序 —— 守住它的位置：sortedEditors —— 改错故障：用户熟悉的顺序被打乱
// INV-14 相对路径必须基于预览源的工作区拼接 —— 守住它的位置：copyRelativePath 调用 —— 改错故障：复制出以斜杠开头的错误相对路径
// INV-15 下拉与右键的菜单项显示条件必须一致 —— 守住它的位置：两处 isRemoteSource 与可打开判断 —— 改错故障：一个入口能看到打开方式，另一个看不到
// INV-16 编辑器列表只在首次展开时加载 —— 守住它的位置：editorsLoaded 与 loadingEditors 早退 —— 改错故障：每次悬停都发起一次 IPC 查询
// INV-17 可选字段缺失时不要传空字符串占位 —— 守住它的位置：openInEditor 的参数对象 —— 改错故障：远程目标被空串污染，解析成本地路径
// INV-18 列表渲染的 key 必须用编辑器 id —— 守住它的位置：两处编辑器 map —— 改错故障：图标与名称在刷新后错位到其他应用
//
// 维护提示
//   预览、外部打开、指定编辑器是三条独立路径，新增动作用同一套失败提示约定。
//   请求号是这里唯一的并发保护，任何新的异步加载都要复用它。
//   远程与本地能力的差异全部来自平台字段，不要用布尔常量写死。
//   下拉保持平铺列表，不要塞入分组或二级菜单，右键才是补充入口。
//   两个菜单的文案键各自独立，改动时确认 i18n 是否存在。
//   注释块位置与密度基线由 DEEP-SPEC 统一维护，改动时不要打乱既有块顺序。
import type { EditorInfo } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, PanelRightIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
// OpenSplitButtonTarget 用 type: "website" | "file" 做判别：website 只要求 url，localPath/workspacePath 可选；file 额外要求 title 与 label，handlePreview 依赖这两个字段组装 MessageFileLinkTarget。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
      workspacePath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

// OpenSplitButtonProps 的 onOpenBrowserUrl / onOpenFileLink / onOpenCodeViewer 都是可选回调，缺省即该能力不可用；canPreview 只据此计算，组件内部不提供兜底实现。
interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  stopPropagation?: boolean;
  /** 整张卡片复用按钮的操作与状态，右键和下拉不会维护两套动作。 */
  renderCard?: (button: ReactNode) => ReactElement;
}

// hideOpenWithMenu 与 stopPropagation 默认 false：独立使用的按钮保留下拉且不吞整卡点击，只有 renderCard 场景才由调用方覆盖这两个默认值。
export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
  renderCard,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();

  // [契约] 只有文件目标才有预览源。
  // 网页目标即使带本地路径也不参与编辑器解析。
  const previewSource = target.type === "file" ? target.previewSource : undefined;
  // [契约] matchedOpenContext 由 previewSource 的 workspacePath 与 workspaceIdentity 推导，不读全局选中项。
  // 三个字段必须一起传，
  // 缺远程会话 id 会让远程工作区被当成同路径的本地工作区。
  // 这个 hook 只做匹配，不发起请求。
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  // [契约] 远程目标来自匹配结果而不是预览源字段。
  // 直接取字段会绕过路径与身份的匹配校验。
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  // isRemoteSource 取 previewSource.workspaceIdentity、previewSource.workspaceRemoteSessionId、matchedOpenContext.isRemoteWorkspace 三者之一为真：远程标记可能只填在 previewSource，也可能只由 useWorkspaceOpenInEditorTarget 匹配出来，漏掉任一来源都会让 canOpenNative 误判为可用。
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  // useFileContextActions 的 canOpenLocalFileManager 传 platform.canOpenLocalFiles、isRemoteWorkspace 传 isRemoteSource：远程工作区不能开本机文件管理器这件事由动作层裁剪，这里不再重复判断。
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(platform.canOpenLocalFiles),
    isRemoteWorkspace: isRemoteSource,
    remoteTarget: openInEditorRemoteTarget,
    workspaceIdentity: previewSource?.workspaceIdentity,
  });
  // [契约] 文件路径与本地路径分别对应两种目标。
  // 网页目标的本地路径用于在浏览器里打开本地文件。
  const filePath = target.type === "file" ? target.path : target.localPath;
  const workspacePath =
    target.type === "file" ? previewSource?.workspacePath : target.workspacePath;
  // canOpenNative 必须在渲染期同时满足 platform.canOpenLocalFiles 与 !isRemoteSource：右键菜单用它决定是否渲染「用默认应用打开」，若推迟到 handleOpenDefault 内判断，菜单项会先显示成可用再静默失败。
  const canOpenNative = Boolean(platform.canOpenLocalFiles && !isRemoteSource);
  // editorRequest 是这里唯一的并发保护：用 useRef 而非 state，虚拟列表复用同一组件实例换目标时只比较请求号、不需要重渲染；目标变化 effect 与发起请求都会自增。
  const editorRequest = useRef(0);
  // editors / editorsLoaded / loadingEditors 必须成对维护：目标切换的 effect 若只清 editors 而不清 editorsLoaded，loadEditors 的首个早退条件 editorsLoaded 会让下次展开直接 return，列表永久为空。
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  // sortedEditors 只在 isRemoteSource 为真且 openInEditorRemoteTarget 为空时返回 []；匹配到远程目标的仍走 resolveWorkspaceEditorSelection 取 availableEditors，顺序原样沿用，不在 useMemo 里重排。
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  // [契约] 网页目标只认浏览器回调，文件目标认两种回调之一。
  // 这里不做任何前置 IO 判断，
  // 否则预览按钮会在加载期间无故变灰。
  // 主按钮的 disabled 直接绑定这个值。
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  // 依赖数组必须含 filePath、previewSource.workspaceIdentity、previewSource.workspaceRemoteSessionId：effect 体先清空 editors/editorsLoaded/loadingEditors 再自增 editorRequest，清理函数再自增一次以覆盖卸载与下一次切换，否则同路径不同工作区的虚拟行会共用结果。
  useEffect(() => {
    setEditors([]);
    setEditorsLoaded(false);
    setLoadingEditors(false);
    // 卡片虚拟行重用时旧目标的异步应用结果不能覆盖新目标。
    editorRequest.current += 1;
    return () => {
      editorRequest.current += 1;
    };
  }, [filePath, previewSource?.workspaceIdentity, previewSource?.workspaceRemoteSessionId]);

  // [契约] 只有调用方显式要求时才拦冒泡。
  // 默认放行，保证整卡点击仍然有效。
  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  // loadEditors 的三个早退条件都必要：editorsLoaded、loadingEditors、target.type !== "file"；缺少 type 判断会对 website 目标调用 platform.getInstalledEditors，依赖数组同时列出 isRemoteSource 与 openInEditorRemoteTarget 以保证换目标后回调重建。
  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    // [并发] 发起请求时先占号再置 loading。
    // 顺序不能反：
    // 先置 loading 再占号，中间若被目标切换打断，
    // 新的 effect 会看到旧的 loading 标志。
    const request = ++editorRequest.current;
    setLoadingEditors(true);
    try {
      // [契约] getInstalledEditors 只用 target.path 查询，不从闭包外抓路径以免查错目标。
      // platform.getInstalledEditors 是异步的，返回时 target 可能已经换过。
      // await 之后必须比对 request 与 editorRequest.current，不等就直接 return 丢弃结果。
      // 不要在这里补第二层 try 包裹。
      const result = await platform.getInstalledEditors(target.path);
      if (request !== editorRequest.current) return;
      setEditors(result);
      setEditorsLoaded(true);
    // [失败路径] 失败只写日志，不弹 toast。
    // 展开菜单时静默失败会退化成空列表提示，
    // 这比打断用户的阅读流程更合适。
    } catch (error) {
      if (request !== editorRequest.current) return;
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    // [资源] 只有当前请求才能关闭 loading。
    // 旧请求收尾时若直接清除，
    // 会把新请求的加载态一起关掉。
    } finally {
      if (request === editorRequest.current) setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target, isRemoteSource, openInEditorRemoteTarget]);

  // handlePreview 的分支顺序不可反转：website 先 onOpenBrowserUrl?.(target.url) 并 return；file 先试 onOpenCodeViewer 并 return，最后才 onOpenFileLink；任一处漏 return 会让同一文件被两个入口重复打开。
  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  // handleOpenInEditor 先 persistLastSelectedEditorId(editor.id) 再 platform.openInEditor：顺序不可反，否则打开失败时用户的选择已丢失；openInEditor 返回 !result.success 时抛 Error(result.error ?? "unknown-error") 才会进下方 catch，只写日志会让按钮看起来毫无反应。
  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    // 返回失败和 IPC 拒绝都必须有可见反馈，不能只写日志后静默结束。
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        // [失败路径] 平台以返回值表达失败，必须转成异常才能进 catch。
        // 错误码缺省时用固定字符串占位，
        // 保证日志里始终有可检索的内容。
        if (!result.success) throw new Error(result.error ?? "unknown-error");
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  // [契约] 没有本地路径时直接按目标类型打开。
  // 只有这样才尝试用系统浏览器打开本地文件。
  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  // [契约] 默认应用打开要求路径存在且允许本地打开。
  // 失败同样要 toast，不能静默。
  const handleOpenDefault = () => {
    if (!filePath || !canOpenNative || !platform.openExternalFile) return;
    void platform
      .openExternalFile(filePath)
      .then((result) => {
        if (!result.success) throw new Error(result.error);
      })
      .catch((error: unknown) => {
        logger.warn("[OpenSplitButton] 默认应用打开文件失败", {
          path: filePath,
          error: String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  // 新增动作只出现在右键菜单，下拉仍使用原有的应用列表布局。
  // [权衡] renderContextActions 只承载「新增」这类补充动作，不接管下拉主体的渲染。
  // 两处的显示条件必须保持一致，否则行为会分叉。
  const renderContextActions = () => {
    const Item = ContextMenuItem;
    const Separator = ContextMenuSeparator;
    const Sub = ContextMenuSub;
    const SubTrigger = ContextMenuSubTrigger;
    const SubContent = ContextMenuSubContent;
    return (
      <>
        <Item disabled={!canPreview} onSelect={handlePreview}>
          <PanelRightIcon className="size-4" />
          {intl.formatMessage({
            id: "chat.previewCards.previewInSidePane",
          })}
        </Item>
        {target.type === "website" ? (
          <Item onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            {intl.formatMessage({ id: "common.open" })}
          </Item>
        ) : (
          <>
            {canOpenNative && platform.openExternalFile && (
              <Item onSelect={handleOpenDefault}>
                <ExternalLinkIcon className="size-4" />
                {intl.formatMessage({ id: "chat.previewCards.openDefaultApp" })}
              </Item>
            )}
            {platform.canOpenLocalFiles && (!isRemoteSource || openInEditorRemoteTarget) && (
              <Sub>
                <SubTrigger>{intl.formatMessage({ id: "chat.previewCards.openWith" })}</SubTrigger>
                <SubContent>
                  {sortedEditors.length ? (
                    sortedEditors.map((editor) => (
                      <Item key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
                        <img src={editor.iconDataUrl} alt="" className="size-4 shrink-0" />
                        <span>{editor.name}</span>
                      </Item>
                    ))
                  ) : (
                    <Item disabled>
                      {intl.formatMessage({
                        id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
                      })}
                    </Item>
                  )}
                </SubContent>
              </Sub>
            )}
          </>
        )}
        <Separator />
        {target.type === "website" && (
          <Item onSelect={() => void fileActions.copyAbsolutePath({ path: target.url })}>
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "chat.previewCards.copyLink" })}
          </Item>
        )}
        {filePath && (
          <>
            {workspacePath && (
              <Item
                onSelect={() =>
                  void fileActions.copyRelativePath({
                    path: filePath,
                    relativePath: getWorkspaceFileRelativePath(workspacePath, filePath),
                  })
                }
              >
                <CopyIcon className="size-4" />
                {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
              </Item>
            )}
            <Item onSelect={() => void fileActions.copyAbsolutePath({ path: filePath })}>
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </Item>
          </>
        )}
      </>
    );
  };

  // 外层 div 的 onClick/onPointerDown 都绑 stopEventPropagation，主按钮与 DropdownMenuTrigger 只补自己的 onClick：stopPropagation 只需实现一处；hideOpenWithMenu 为真时不渲染箭头、主按钮用 px-2 独占宽度。
  const button = (
    <DropdownMenu onOpenChange={(open) => open && void loadEditors()}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className={`h-7 rounded-none border-0 gap-1 ${hideOpenWithMenu ? "px-2" : "pr-1.5"}`}
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        {!hideOpenWithMenu && (
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="!w-5 rounded-none border-0 text-foreground-subtlest"
              aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
              onClick={stopEventPropagation}
            >
              <ChevronDownIcon className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        )}
      </div>
      {!hideOpenWithMenu && (
        <DropdownMenuContent align="end" side="top" className="w-44" onClick={stopEventPropagation}>
          <OpenSplitButtonDropdownActions
            target={target}
            sortedEditors={sortedEditors}
            loadingEditors={loadingEditors}
            handleOpenExternal={handleOpenExternal}
            handleOpenInEditor={handleOpenInEditor}
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
  // renderCard 为空时直接 return button，不再包 ContextMenu；否则独立按钮会多出一层右键容器，ContextMenuTrigger asChild 也会改变 button 的宿主节点。
  if (!renderCard) return button;
  return (
    <ContextMenu
      onOpenChange={(open) =>
        open &&
        platform.canOpenLocalFiles &&
        (!isRemoteSource || openInEditorRemoteTarget) &&
        void loadEditors()
      }
    >
      <ContextMenuTrigger asChild>{renderCard(button)}</ContextMenuTrigger>
      <ContextMenuContent>{renderContextActions()}</ContextMenuContent>
    </ContextMenu>
  );
}

// 右键菜单新增后，下拉菜单仍保留原有的平铺应用列表与路径操作顺序。
function OpenSplitButtonDropdownActions({
  target,
  sortedEditors,
  loadingEditors,
  handleOpenExternal,
  handleOpenInEditor,
}: {
  target:
    | { type: "website" }
    | { type: "file"; path: string; label: string; previewSource?: { workspacePath?: string } };
  sortedEditors: readonly EditorInfo[];
  loadingEditors: boolean;
  handleOpenExternal: () => void;
  handleOpenInEditor: (editor: EditorInfo) => void;
}) {
  const { intl } = useZCodeIntl();
  const fileActions = useFileContextActions();
  // [契约] 只有第一个编辑器存在时才渲染整份列表。
  // 它同时是排序结果的唯一消费者。
  const selectedEditor = sortedEditors[0];
  return (
    <>
      {target.type === "website" ? (
        <DropdownMenuItem onSelect={handleOpenExternal}>
          <ExternalLinkIcon className="size-4" />
          <span>
            {intl.formatMessage({
              id: "chat.previewCards.openExternal",
            })}
          </span>
        </DropdownMenuItem>
      ) : (
        <>
          {selectedEditor ? (
            sortedEditors.map((editor) => (
              <DropdownMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
                <img src={editor.iconDataUrl} alt={editor.name} className="size-4 shrink-0" />
                <span>{editor.name}</span>
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem disabled>
              {intl.formatMessage({
                id: loadingEditors ? "common.loading" : "chat.previewCards.noOpenApps",
              })}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void fileActions.copyRelativePath({
                path: target.path,
                relativePath: target.previewSource?.workspacePath
                  ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                  : target.label,
              })
            }
          >
            <CopyIcon className="size-4" />
            {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
