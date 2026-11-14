// INV-01 无 workspace 早退：守住位置 WorkspaceFileSearchSection 的判空分支；改错故障：无 workspace 时仍挂服务解析 hook，触发 context 缺失报错。
// INV-02 草稿唯一编辑面：守住位置 draft 状态；改错故障：直接改 loaded 导致撤销语义丢失。
// INV-03 保存才落盘：守住位置 handleSave 的写文件调用；改错故障：输入即写盘，用户无法放弃修改。
// INV-04 分区操作：守住位置 applyTransform 的 transform 参数；改错故障：同步与恢复默认互相覆盖对方的标记区。
// INV-05 版本防竞态：守住位置 loadVersionRef 的比对；改错故障：旧请求覆盖新 workspace 的规则内容。
// INV-06 loading 收口：守住位置 finally 里的版本判断；改错故障：旧请求提前关闭新请求的加载态。
// INV-07 服务就绪门禁：守住位置 rpcReady 判断；改错故障：服务未就绪时发起调用而报错。
// INV-08 模板态可保存：守住位置 canSave 的 template 分支；改错故障：首次进入页面无法创建规则文件。
// INV-09 差异才提示：守住位置 dirty 的 file 分支；改错故障：模板态未编辑也显示未保存。
// INV-10 快捷键等价按钮：守住位置 Ctrl/Cmd+S 分支；改错故障：门控与按钮不一致，出现可保存却无响应。
// INV-11 远程不展示打开位置：守住位置 isLocalWorkspace 判断；改错故障：远程 workspace 弹出本地文件管理器失败提示。
// INV-12 打开位置需已落盘：守住位置 revealTargetReady 条件；改错故障：文件尚未创建时打开目录无意义。
// INV-13 失败不抛：守住位置 读取、变换、保存的 catch；改错故障：异常冒泡打断渲染。
// INV-14 失败保留现场：守住位置 catch 中的状态处理；改错故障：保存失败清空草稿导致内容丢失。
// INV-15 就绪前不拉取：守住位置 load 与 effect 的提前返回；改错故障：workspace 为空时发起读取。
// INV-16 切换先清空：守住位置 effect 里的重置顺序；改错故障：切换 workspace 后短暂显示上一份规则。
// INV-17 文案全走 intl：守住位置 所有可见文案的 formatMessage；改错故障：界面出现硬编码中文或英文。
// INV-18 规则文本等宽：守住位置 Textarea 的字体类；改错故障：忽略规则排版错位难以核对。
//
// 模块职责：提供工作区 .zcodeignore 的查看、编辑、分区同步与恢复默认入口。
// 状态所有权：编辑器组件持有已加载内容与草稿；服务层持有磁盘上的规则文件。
// 阅读顺序：入口分流 → 状态与加载 → 分区变换 → 保存门控 → 打开位置与交互按钮。
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, RotateCcw, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { logger } from "@/logger.js";

interface WorkspaceFileSearchSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}

// 忽略规则状态：content 是文件文本，source 区分已落盘文件与模板。
// source 同时决定保存门控与「打开文件位置」是否可用。
//
type IgnoreFileState = {
  content: string;
  source: "file" | "template";
};

/**
 * 工作区文件搜索忽略规则（.zcodeignore）编辑页。
 * 规则文件是目录排除的单一真相源：编辑保存即生效（下次扫描读取新内容）；
 * 「从 .gitignore 同步」与「恢复默认规则」是分区操作：只重写各自标记区
 * （gitignore 同步区 / 默认排除段），用户自定义规则区不受影响；结果填入编辑框，
 * 仍需保存才落盘。
 */
// 无 workspace 时直接返回提示，不挂服务解析 hook，避免无谓的 context 依赖。
// 有 workspace 才渲染编辑器，把解析链限制在真正需要的位置。
// 本层不取数：读取与写盘全部由 `ActiveWorkspaceFileSearchEditor` 负责。
//
export function WorkspaceFileSearchSection({
  workspacePath,
  workspaceIdentity,
}: WorkspaceFileSearchSectionProps) {
  // 无 workspace 时直接提示，不挂 workspace 服务解析 hook 链（同 SessionPluginReferenceIconBoundary
  // 的分层先例），避免无谓的 services/tabStore context 依赖。
  if (!workspacePath) {
    return <NoWorkspaceFileSearchHint />;
  }
  return (
    <ActiveWorkspaceFileSearchEditor
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
    />
  );
}

function NoWorkspaceFileSearchHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.workspaceFileSearch.noWorkspace" })}
    </p>
  );
}

// 编辑器持有全部可变状态：已加载内容、草稿、加载中与保存中标志。
// draft 是唯一编辑面，任何写盘都必须经过保存动作。
//
function ActiveWorkspaceFileSearchEditor({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  const [loaded, setLoaded] = useState<IgnoreFileState | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadVersionRef = useRef(0);

  // 加载带版本号防竞态：每次调用自增，返回时版本不符即丢弃结果。
  // 读取失败只提示不抛出，页面保留可编辑的空态。
  // finally 里同样校验版本，避免旧请求关掉新请求的加载态。
  //
  const load = useCallback(async () => {
    if (!workspacePath || !rpcReady) {
      return;
    }
    const version = loadVersionRef.current + 1;
    loadVersionRef.current = version;
    setLoading(true);
    try {
      const result = await services.fileService.readWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
      });
      if (loadVersionRef.current !== version) {
        return;
      }
      setLoaded({ content: result.content, source: result.source });
      setDraft(result.content);
    } catch (error) {
      if (loadVersionRef.current !== version) {
        return;
      }
      logger.warn("[WorkspaceFileSearchSection] 读取 .zcodeignore 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.loadFailed" }));
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false);
      }
    }
  }, [intl, rpcReady, services, workspacePath]);

  // 分区操作：只重写对应标记区（sync-gitignore 重写 gitignore 同步区；reset-defaults
  // 重置默认排除段），用户自定义规则区不受影响；结果填充编辑框，保存才落盘。
  // 分区操作只重写各自标记区，用户自定义规则区不受影响。
  // 结果只写进草稿 `draft`：已加载内容不变，改动仍可放弃。
  // 变换同样走版本号，避免与服务端返回顺序错位。
  //
  const applyTransform = useCallback(
    async (transform: "sync-gitignore" | "reset-defaults") => {
      if (!workspacePath || !rpcReady) {
        return;
      }
      const version = loadVersionRef.current + 1;
      loadVersionRef.current = version;
      try {
        const result = await services.fileService.applyWorkspaceFileSearchIgnoreTransform({
          rootPath: workspacePath,
          transform,
        });
        if (loadVersionRef.current !== version) {
          return;
        }
        // 只更新编辑框内容；loaded 保持不变，dirty 语义由内容差异自然产生。
        setDraft(result.content);
      } catch (error) {
        if (loadVersionRef.current !== version) {
          return;
        }
        logger.warn("[WorkspaceFileSearchSection] 应用 .zcodeignore 分区操作失败", {
          transform,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.workspaceFileSearch.transformFailed" }));
      }
    },
    [intl, rpcReady, services, workspacePath],
  );

  // workspace 切换时先清空草稿与已加载态，再触发拉取。
  // 未就绪时直接结束 loading，避免空白页一直转圈。
  // 依赖里带 load，服务实例变化会重新加载。
  //
  useEffect(() => {
    if (!workspacePath || !rpcReady) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoaded(null);
    setDraft("");
    void load();
    // load 是依赖 workspace/services 的回调；workspace 切换时先重置再拉取。
  }, [load, rpcReady, workspacePath]);

  // 保存把草稿整体写盘，成功后把来源标记为文件，差异自然归零。
  // 失败保留草稿并提示，用户可重试而不丢内容。
  //
  const handleSave = useCallback(async () => {
    if (!workspacePath) {
      return;
    }
    setSaving(true);
    try {
      await services.fileService.writeWorkspaceFileSearchIgnore({
        rootPath: workspacePath,
        content: draft,
      });
      setLoaded({ content: draft, source: "file" });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saved" }));
    } catch (error) {
      logger.warn("[WorkspaceFileSearchSection] 保存 .zcodeignore 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.workspaceFileSearch.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [draft, intl, services, workspacePath]);

  // 保存语义是"把编辑框内容落盘"：template 态（.zcodeignore 尚未创建）即使未编辑也允许保存，
  // 否则用户第一次进页面什么都不改就永远无法创建文件；已落盘态才按"有修改才可保存"门控。
  // 保存门控三分支：尚未加载、模板态、内容有差异。
  // 模板态允许原样保存，否则首次进入永远无法创建规则文件。
  // dirty 只表达真实差异，模板态未编辑时不显示未保存提示。
  //
  const canSave = loaded === null || loaded.source === "template" || draft !== loaded.content;
  // "有未保存的修改"提示只表达真实差异（template 态未编辑时不显示）。
  const dirty = loaded !== null && loaded.source === "file" && draft !== loaded.content;

  // 「打开文件位置」：.zcodeignore 位于 workspace 根，打开根目录即所在位置
  // （与 WindowsCaptionMenuButton/ModelTrajectoryPane 先例一致传目录）。
  // 远程 workspace 的规则文件在远端机器，本地文件管理器无法打开，按钮不展示。
  // `WorkspaceFileSearchSection` 读到的规则文件在宿主机器：本地打不开预览，入口不展示。
  // 本地时打开的是 workspace 根目录，即规则文件所在位置。
  //
  const isLocalWorkspace = !workspaceIdentity?.trim();
  const revealTargetReady = loaded?.source === "file";
  const handleReveal = useCallback(async () => {
    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      toast(intl.formatMessage({ id: "appHeader.openInFileManagerFailed" }));
    }
  }, [intl, platform, workspacePath]);

  return (
    // 排版对齐设置页统一规范：导语 + SettingsGroupCard 卡片，
    // 文字统一 text-ui-base；textarea 因内容是规则文本保留等宽字体。
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.workspaceFileSearch.description" })}
      </div>
      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          {loaded?.source === "template" ? (
            <div className="text-ui-base leading-6 text-foreground-subtle">
              {intl.formatMessage({ id: "settings.workspaceFileSearch.templateHint" })}
            </div>
          ) : null}
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // 保存快捷键：编辑器内 Ctrl/Cmd+S 与点保存按钮等价（preventDefault
              // 阻止浏览器默认行为）；门控与按钮一致（canSave）。
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (canSave && !saving && !loading) {
                  void handleSave();
                }
              }
            }}
            spellCheck={false}
            disabled={loading || saving}
            className="min-h-64 w-full font-mono text-ui-base"
            aria-label={intl.formatMessage({ id: "settings.workspaceFileSearch.editorLabel" })}
            data-testid="workspace-file-search-ignore-editor"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={!canSave || saving || loading}
              onClick={() => void handleSave()}
              data-testid="workspace-file-search-ignore-save"
            >
              <Save className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.save" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("sync-gitignore")}
              data-testid="workspace-file-search-ignore-resync"
            >
              <RotateCcw className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.resync" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || saving}
              onClick={() => void applyTransform("reset-defaults")}
              data-testid="workspace-file-search-ignore-restore-defaults"
            >
              <Undo2 className="size-4" />
              {intl.formatMessage({ id: "settings.workspaceFileSearch.restoreDefaults" })}
            </Button>
            {isLocalWorkspace ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!revealTargetReady || loading || saving}
                title={
                  revealTargetReady
                    ? undefined
                    : intl.formatMessage({ id: "settings.workspaceFileSearch.revealHint" })
                }
                onClick={() => void handleReveal()}
                data-testid="workspace-file-search-ignore-reveal"
              >
                <FolderOpen className="size-4" />
                {intl.formatMessage({ id: "settings.workspaceFileSearch.reveal" })}
              </Button>
            ) : null}
            {dirty ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.workspaceFileSearch.unsaved" })}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
