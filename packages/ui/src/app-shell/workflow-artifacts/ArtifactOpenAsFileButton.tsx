// INV-01 能力探测是唯一开关：守住位置 canOpenAsFile；改错故障 按钮出现在不支持的宿主。
// INV-02 探测同时要求两个平台方法：守住位置 双字段判断；改错故障 半实现宿主打开即崩。
// INV-03 不支持时整块缺席：守住位置 返回 null；改错故障 头部留下空壳。
// INV-04 版本化路径缓存：守住位置 pathsRef 的键；改错故障 切换版本后打开旧副本。
// INV-05 缓存存的是 Promise：守住位置 set 时机；改错故障 连点两次触发两次物化。
// INV-06 失败即出缓存：守住位置 catch 清理；改错故障 失败被永久记住无法重试。
// INV-07 字节未就绪直接拒绝：守住位置 bytes 判空；改错故障 空字节写出损坏文件。
// INV-08 主按钮走系统默认应用：守住位置 handleOpenDefault；改错故障 点击无响应。
// INV-09 编辑器选择会持久化偏好：守住位置 persistLastSelectedEditorId；改错故障 每次都要重选。
// INV-10 本机路径不带远程目标：守住位置 openInEditor 选项；改错故障 副本被当远端路径。
// INV-11 打开列表首次展开才加载：守住位置 loadEditors；改错故障 挂载即发起 IPC。
// INV-12 列表失败回落空数组：守住位置 catch 分支；改错故障 菜单永久停在加载中。
// INV-13 显示原位仅在提供回调时出现：守住位置 onReveal 判断；改错故障 菜单出现死项。
// INV-14 打开失败统一提示：守住位置 reportFailure；改错故障 失败静默无反馈。
// INV-15 失败日志带动作与标识：守住位置 日志字段；改错故障 无法定位是哪一版失败。
// INV-16 两个触发按钮同步禁用：守住位置 disabled 变量；改错故障 仅主动作禁用菜单仍可点。
// INV-17 菜单文字全部走 i18n：守住位置 formatMessage；改错故障 出现硬编码文案。
// INV-18 复制路径同样先物化：守住位置 handleCopyPath；改错故障 复制到空字符串。
//
// 模块职责：产物页头部的「作为文件打开」分段按钮与打开方式菜单。
// 状态所有权：编辑器列表与路径缓存为组件局部状态，跨版本按版本号隔离。
// 阅读顺序：先看能力探测，再看路径缓存，最后看菜单动作与失败处理。
import { useCallback, useRef, useState } from "react";
import type { EditorInfo, IPlatformService } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

/**
 * 产物 tab 头部的「作为文件打开」分段按钮（docs/dynamic-workflow/authoring.md「How the user sees them」）。
 *
 * ⚠ 术语：artifact = 脚本经 `artifact.*` 发布给用户看的产出，不是引擎的 `RunSettlement.artifact`。
 *
 * 文件是宿主按 tab **已经读到的那一版字节**写出的本机副本（`materializeWorkflowArtifactFile`），
 * 不是 CLI artifact store 里的文件——理由见 desktop 的 `workflowArtifactFile.ts`。主按钮用系统
 * 默认 App 打开；chevron 列出已装 App（与其它「打开方式」同一份列表与偏好，文件管理器在前），
 * 其后是位置类动作：「在工作区显示」（产物有本机可达的工作区出处时）与「复制绝对路径」。
 * 「在工作区显示」收进这里，是为了头部只留一个文件控件；宿主不能落副本（手机远控、普通 Web）
 * 时整个按钮缺席，调用方据 {@link useCanOpenArtifactAsFile} 把「在工作区显示」放回头部。
 */
// 四个标识共同定位一个副本。
// 文件名决定系统打开方式。
// 字节未读到时为 null。
// onReveal 显示原位回调完全可选。
// onReveal 缺席时菜单少一项「在工作区显示」。
interface ArtifactOpenAsFileButtonProps {
  runId: string;
  artifactId: string;
  version: number;
  /** 副本的文件名（含扩展名，扩展名决定系统用哪个 App 打开）。 */
  fileName: string;
  /** **这一版**的字节；还没读到（或读到的属于别的版本）时传 null，按钮禁用。 */
  bytes: Uint8Array | null;
  /** 「在工作区显示」：已绑定好路径的文件树 reveal；缺席即菜单里没有这一项。 */
  onReveal?: () => void;
}

type MaterializeCapablePlatform = IPlatformService &
  Required<Pick<IPlatformService, "materializeWorkflowArtifactFile" | "openExternalFile">>;

// platform 非空是 canOpenAsFile 的判型前提。
// materializeWorkflowArtifactFile 与 openExternalFile 都必须存在。
// 两者任一为 undefined 时直接判定不支持。
// 该类型谓词同时供渲染与 openWith 菜单分流使用。
// canOpenAsFile 是纯同步判定，不做任何异步探测。
function canOpenAsFile(platform: IPlatformService | null): platform is MaterializeCapablePlatform {
  return (
    platform !== null &&
    platform.materializeWorkflowArtifactFile !== undefined &&
    platform.openExternalFile !== undefined
  );
}

/** 当前宿主能不能「作为文件打开」——头部据此决定「在工作区显示」进菜单还是独立成按钮。 */
export function useCanOpenArtifactAsFile(): boolean {
  return canOpenAsFile(useOptionalPlatform());
}

export function ArtifactOpenAsFileButton(props: ArtifactOpenAsFileButtonProps) {
  const platform = useOptionalPlatform();
  if (!canOpenAsFile(platform)) return null;
  return <OpenAsFileSplitButton {...props} platform={platform} />;
}

function OpenAsFileSplitButton({
  runId,
  artifactId,
  version,
  fileName,
  bytes,
  onReveal,
  platform,
}: ArtifactOpenAsFileButtonProps & { platform: MaterializeCapablePlatform }) {
  const { intl } = useZCodeIntl();
  const [editors, setEditors] = useState<EditorInfo[] | null>(null);

  // 一版一个副本路径：同一版再打开不再把最多 20 MiB 的字节重传一遍 IPC。存的是 promise，
  // 连点两下也只落一次；失败即出缓存，下一次点击重试。
  const pathsRef = useRef(new Map<string, Promise<string>>());
  // 键由四个字段拼接而成。
  // 命中缓存直接复用同一个 Promise。
  // bytes 为 null 时不发起物化。
  // 成功后把 pending 写入 pathsRef 缓存。
  // 失败时立刻从 pathsRef 删除该 key 以便重试。
  const ensureLocalPath = useCallback((): Promise<string> => {
    const key = `${runId}\u0000${artifactId}\u0000${version}\u0000${fileName}`;
    const cached = pathsRef.current.get(key);
    if (cached !== undefined) return cached;
    if (bytes === null) return Promise.reject(new Error("artifact bytes are not loaded"));
    const pending = platform
      .materializeWorkflowArtifactFile({ runId, artifactId, version, fileName, bytes })
      .then((result) => result.localPath);
    pathsRef.current.set(key, pending);
    pending.catch(() => pathsRef.current.delete(key));
    return pending;
  }, [artifactId, bytes, fileName, platform, runId, version]);

  const reportFailure = useCallback(
    (action: string, error: unknown) => {
      logger.warn("[workflow-artifacts] 作为文件打开失败", {
        action,
        artifactId,
        error: error instanceof Error ? error.message : String(error),
        runId,
        version,
      });
      toast(intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFileFailed" }));
    },
    [artifactId, intl, runId, version],
  );

  const openWith = useCallback(
    (
      action: string,
      open: (localPath: string) => Promise<{ success: boolean; error?: string }>,
    ) => {
      void ensureLocalPath()
        .then(open)
        .then((result) => {
          if (!result.success) reportFailure(action, result.error ?? "unknown-error");
        })
        .catch((error: unknown) => reportFailure(action, error));
    },
    [ensureLocalPath, reportFailure],
  );

  const handleOpenDefault = () =>
    openWith("default-app", (localPath) => platform.openExternalFile(localPath));

  const handleOpenInEditor = (editor: EditorInfo) => {
    persistLastSelectedEditorId(editor.id);
    // 副本恒在宿主本机上：远程工作区也不带 remoteTarget，否则会被当成远端路径去开。
    openWith(`editor:${editor.id}`, (localPath) =>
      platform.openInEditor(editor.id, localPath, { pathKind: "file" }),
    );
  };

  const handleCopyPath = () => {
    void ensureLocalPath()
      .then((localPath) => navigator.clipboard?.writeText(localPath))
      .catch((error: unknown) => reportFailure("copy-path", error));
  };

  const loadEditors = () => {
    if (editors !== null) return;
    void platform
      .getInstalledEditors()
      .then((installed) => setEditors(sortInstalledEditorsForOpenWith(installed)))
      .catch((error: unknown) => {
        logger.warn("[workflow-artifacts] 获取打开方式失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        setEditors([]);
      });
  };

  const disabled = bytes === null;
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.openAsFile" });
  const chooseLabel = intl.formatMessage({ id: "appHeader.selectOpenApp" });

  return (
    <DropdownMenu onOpenChange={(open) => open && loadEditors()}>
      {/* 分段外壳：主动作在左、菜单在右（DESIGN.md「Composite triggers」）。高度对齐头部的 sm 按钮。 */}
      <div className="flex h-6 shrink-0 items-center overflow-hidden rounded-md border border-border bg-input transition-colors hover:border-border-hover">
        <Button
          className="h-6 rounded-none border-0 pr-1.5"
          data-testid="workflow-artifact-open-as-file"
          disabled={disabled}
          onClick={handleOpenDefault}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          {label}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={chooseLabel}
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            data-testid="workflow-artifact-open-as-file-menu"
            disabled={disabled}
            size="icon-sm"
            title={chooseLabel}
            type="button"
            variant="ghost"
          >
            <ChevronDownIcon aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-48">
        {editors === null || editors.length === 0 ? (
          <DropdownMenuItem disabled>
            {intl.formatMessage({
              id: editors === null ? "common.loading" : "chat.previewCards.noOpenApps",
            })}
          </DropdownMenuItem>
        ) : (
          editors.map((editor) => (
            <DropdownMenuItem key={editor.id} onSelect={() => handleOpenInEditor(editor)}>
              <img alt="" className="size-4 shrink-0" src={editor.iconDataUrl} />
              <span className="truncate">{editor.name}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        {onReveal === undefined ? null : (
          // 显示的是工作区里的原件，不落副本（与 tab 头部原来那颗按钮同一条路径）。
          <DropdownMenuItem data-testid="workflow-artifact-open-as-file-reveal" onSelect={onReveal}>
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={handleCopyPath}>
          <CopyIcon aria-hidden="true" className="size-4" />
          {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
