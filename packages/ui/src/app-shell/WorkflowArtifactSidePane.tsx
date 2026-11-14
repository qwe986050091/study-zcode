// INV-01 零产物必须复用模块级冻结空数组，不得每帧新建字面量；守住位置：EMPTY_SUMMARIES 与 live 计算；改错故障：合并依赖持续变化，journal 被反复查询并引发渲染抖动。
// INV-02 父会话租约必须由同一个副作用成对登记与释放；守住位置：WorkflowArtifactContent 的登记与清理；改错故障：面板关闭后父会话仍被持有，订阅与内存只增不减。
// INV-03 租约只能经 setLease 在副作用内落地，渲染期不得直接登记；守住位置：lease 状态与依赖列表；改错故障：重复渲染触发多次登记，引用计数失衡。
// INV-04 投影必须绑定当前租约，租约未落地时不得读取快照；守住位置：useConversationProjection 调用；改错故障：首帧读到空投影，产物清单闪现缺失文案。
// INV-05 run 定位必须同时锁定 runId 与 workflowRuns 快照；守住位置：run 的记忆化查找；改错故障：跨 run 复用了别人的产物清单。
// INV-06 live 三态不可折叠，缺席与零产物语义相反；守住位置：live 判定与数据源标记；改错故障：冷恢复被误报为没有产物，或多做一次全量查询。
// INV-07 产物缺失必须区分读取中、读不到详情、确实不存在三档；守住位置：artifact 为空的分支；改错故障：已被清理的产物永远停在加载文案上。
// INV-08 正文组件只在产物存在时挂载，两次渲染的 hook 数量必须恒定；守住位置：顶层条件渲染；改错故障：hook 顺序变化导致运行时报错或状态串位。
// INV-09 选中版本初值只取打开时的 tab.version，之后由用户翻动；守住位置：selectedVersion 初始化；改错故障：每次重渲染都把用户拽回最新版。
// INV-10 版本重置副作用只能依赖产物 id 与版本号，不得自依赖选中值；守住位置：重置版本的 useEffect；改错故障：翻页瞬间被回弹，或形成无限重渲染。
// INV-11 可选版本只信 journal 报回的数组，禁止按序数编造连续版本；守住位置：availableVersions 计算；改错故障：步进器指向取不到字节的版本号。
// INV-12 当前版本必须回落到可选数组内的合法成员；守住位置：version 的三元回退；改错故障：越界请求让字节状态长期停在错误上。
// INV-13 字节请求与预置看板必须互斥启停；守住位置：bytes hook 的 enabled；改错故障：看板额外拉一份用不上的字节，首屏变慢并浪费带宽。
// INV-14 字段清单未就绪时条目请求必须关闭；守住位置：data hook 的 enabled 与字段入参；改错故障：spec 未到时按空字段取数，拿到整份数据或直接失败。
// INV-15 只有属于当前版本的字节才能交给作为文件打开的控件；守住位置：打开控件的 bytes 入参；改错故障：用户下载到上一版内容却按新版命名。
// INV-16 本机路径必须同时满足有出处、可在工作区定位、且非远程会话；守住位置：localSourcePath 计算；改错故障：远程产物点在工作区显示后打开本机不存在的路径。
// INV-17 复制提示的定时器必须随副作用清理；守住位置：copied 的 useEffect；改错故障：连续点击后提示提前复位，卸载后仍向组件写状态。
// INV-18 复制能力必须同时要求非看板、字节到位、文本内容类型；守住位置：copyable 判定；改错故障：对二进制产物露出复制按钮，粘贴出乱码。
// INV-19 面板工作区作用域必须随路径、身份、远程会话三者共同重建；守住位置：WorkflowArtifactSidePane 的 scope 记忆化；改错故障：切换工作区后仍用旧作用域，读到别处的投影。
//
// 本文件是工作流产物的侧栏查看器：头部给出类型、标题与版本步进，正文按产物种类渲染字节、看板条目或图片。
// 元数据、字节、看板条目各自一条数据通道，互不借用；改其中一条前先确认另外两条的启停条件没有被牵连。
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { TID_WORKFLOW_ARTIFACT_PANE } from "@zcode/shared";
import type { WorkflowRunArtifactSummary } from "@zcode/shared/zcode-protocol-v4";
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon, FolderOpenIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  ArtifactKindIcon,
  artifactDisplayTitle,
  artifactKindMessageId,
  artifactOpenAsFileName,
  canRevealArtifactInWorkspace,
  isArtifactPresetKind,
  isTextArtifactContentType,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import {
  ArtifactOpenAsFileButton,
  useCanOpenArtifactAsFile,
} from "@/app-shell/workflow-artifacts/ArtifactOpenAsFileButton.js";
import { WorkflowArtifactBody } from "@/app-shell/workflow-artifacts/WorkflowArtifactBody.js";
import { artifactPresetFieldPaths } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { useWorkflowRunArtifactBytes } from "@/hooks/useWorkflowRunArtifactBytes.js";
import { useWorkflowRunArtifactData } from "@/hooks/useWorkflowRunArtifactData.js";
import {
  useWorkflowRunArtifacts,
  type WorkflowRunArtifactView,
} from "@/hooks/useWorkflowRunArtifacts.js";
import { joinFilePath } from "@/lib/path.js";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { resolveTheme, type Theme } from "@/useTheme.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/**
 * 稳定引用的空摘要列表：`artifacts` 键在零产物时**缺席**，坍缩成一个每帧新造的 `[]`
 * 会让合并 hook 的依赖每帧都变，于是每帧重查一次 journal。
 */
// 模块级冻结数组，引用终身不变，live 的三态判定与依赖比较都靠它。
const EMPTY_SUMMARIES: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowArtifactContent = memo(function WorkflowArtifactContent({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  // [资源] 租约初值刻意留空，首帧不读任何会话数据。
  // 租约登记必须放在 useEffect 里，渲染期只做纯计算，因此首帧不读取任何会话数据。
  const [lease, setLease] = useState<SessionLease | null>(null);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");

  // 订阅**父会话**的投影（照 PlanDetail / WorkflowRun 详情页）：产物的新鲜元数据是父会话
  // 投影的一部分，不是这个面板的本地缓存。
  useEffect(() => {
    // [资源] 父会话切换时先登记新租约，旧租约由上一轮清理函数释放。
    // 句柄只存在于本作用域，不缓存到状态或模块变量，避免重复释放。
    // 同一会话被多处订阅时由数据层按引用计数合并，这里无需自行去重。
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    // [资源] 清理函数必须原样交还，由 React 在依赖变化或卸载时调用。
    // 若当场调用再返回空，切换父会话会让刚登记的租约立刻被释放。
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  // runId 与 run 快照共同作为依赖，保证清单来自同一次投影。
  // 快照整体替换时重新查找即可，不做增量补丁。
  const run = useMemo(
    () => state.snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [state.snapshot?.workflowRuns, tab.runId],
  );
  // run 不在活投影里（冷恢复 / 被 8-run 上限淘汰）⇒ 整份清单走 journal；在场但零产物 ⇒ 空数组。
  // [权衡] 缺席的产物键折成共享空数组，而非每帧新建一个空字面量。
  // undefined 表示这份 run 不在活投影里，交给 journal 全量查询。
  // 空数组表示 run 在场且确实零产物，是确定的空，不必再查一次。
  const live = run === undefined ? undefined : (run.artifacts ?? EMPTY_SUMMARIES);
  const {
    artifacts,
    loading: metadataLoading,
    unavailable,
  // [失败路径] 活投影与 journal 的合并发生在这个 hook 内部。
  // live 仅在存在时透传；缺席就完全不传该键，让 hook 走全量路径。
  } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(live === undefined ? {} : { live }),
  });

  // 按 id 在清单里定位，命中就进入头部与正文，未命中交给占位。
  // 依赖只到清单与 id，切换产物不会牵连其他记忆化结果。
  const artifact = useMemo(
    () => artifacts.find((candidate) => candidate.id === tab.artifactId),
    [artifacts, tab.artifactId],
  );

  // [失败路径] 下面的占位必须分三档：读取中、此会话读不到详情、这个 id 不存在。
  // 最后一档意味着 run 的 journal 已被清理，或 chip 指向了已消失的产物。
  // 合并成一档会让已消失的产物永远停在读取文案上，用户只能反复重开面板。
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-artifact-source={live === undefined ? "journal" : "live"}
      data-testid={TID_WORKFLOW_ARTIFACT_PANE}
      data-workflow-artifact-id={tab.artifactId}
      data-workflow-run-id={tab.runId}
    >
      {artifact === undefined ? (
        // 三态必须分开：还在读 / 这个会话读不到产物详情（老 CLI）/ 读完了但这个 id 不在
        // （run 的 journal 已被清理，或 chip 指向的产物不存在）。合并成一句「正在读取」的
        // 结果是最后一种情形永远停在加载文案上。
        <div className="flex h-full items-center justify-center p-6 text-center">
          <p
            className="text-ui-base text-foreground-subtle"
            data-testid="workflow-artifact-placeholder"
          >
            {intl.formatMessage({
              id: metadataLoading
                ? "chat.toolCall.workflow.run.artifacts.loading"
                : unavailable
                  ? "chat.toolCall.workflow.run.artifacts.unavailable"
                  : "chat.toolCall.workflow.run.artifacts.missing",
            })}
          </p>
        </div>
      ) : (
        <WorkflowArtifactView
          artifact={artifact}
          metadataLoading={metadataLoading}
          tab={tab}
          theme={theme}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
        />
      )}
    </div>
  );
});

/**
 * 头部 + 正文。产物已确定在场时才挂载，所以字节与条目的两个 hook 在这里可以无条件调用
 * （产物缺席那一帧根本不渲染这个组件，hooks 数量因此恒定）。
 */
function WorkflowArtifactView({
  artifact,
  metadataLoading,
  tab,
  theme,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  artifact: WorkflowRunArtifactView;
  /** 元数据（含预置看板的 spec）还在读；正文据此区分「还没到」与「真的没有」。 */
  metadataLoading: boolean;
  tab: WorkflowArtifactSidePaneTab;
  theme: Theme;
  onOpenBrowserUrl?: (url: string) => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 正文通道由 preset 分流：看板走预置渲染，普通产物读字节，因此子组件不再重复判断。
  // 它也决定字节请求是否启动，子组件不要再重复判定。
  const preset = isArtifactPresetKind(artifact.kind);

  // 版本步进器的落点。tab 上的 `version` 只是**打开时**的初始值（chip 从不带版本号，
  // 缺席即最新版）；之后由用户翻。产物换了（同一个 tab 不会，但组件可能被复用）或最新版
  // 抬升时重置回最新版——正在看历史版本时新版落地，跳走会很突兀，所以只在 id 变化时重置。
  // tab 上的版本号只是打开瞬间的初值，chip 通常不带版本，缺席即最新。
  // 之后翻页完全由本地状态驱动，不回调上层，也不写回 tab。
  // 因此再次打开时 selectedVersion 必须回到 tab.version：查看历史只是临时动作，不写回 tab。
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(tab.version);
  useEffect(() => {
    setSelectedVersion(tab.version);
  }, [artifact.id, tab.version]);

  // 可翻的版本范围以 journal 报回的数组为准，顺序即从旧到新。
  // 数组缺失或为空时只保留当前版本一项，步进器因此自动降级为纯文本。
  // 不要用当前版本号反推连续区间，那会造出一批取不到字节的落点。
  const availableVersions = useMemo(() => {
    if (artifact.versions !== undefined && artifact.versions.length > 0) {
      return artifact.versions.map((entry) => entry.version);
    }
    // journal 读不到（老 CLI / 读失败）时只有最新版可看——不要凭 `version` 编造 1..n，
    // 那会让步进器指向一批取不到字节的版本号。
    return [artifact.version];
  }, [artifact.version, artifact.versions]);

  // [失败路径] 选中值越界或已被数组淘汰时回落到产物当前版本。
  // 越界不会抛错，只会让字节请求空转，所以必须在此拦下。
  const version =
    selectedVersion !== undefined && availableVersions.includes(selectedVersion)
      ? selectedVersion
      : artifact.version;
  const versionIndex = availableVersions.indexOf(version);
  // 是否最新版只用于提示与文案，不参与任何请求参数。
  // version 与 artifact.version 不等时必须提示还有更新，因此正文读 isLatestVersion 而不是 artifact.version。
  const isLatestVersion = version === artifact.version;

  // [资源] 字节按版本拉取，版本一变就换一条请求。
  // 看板不读字节，enabled 取反正是为了省掉这趟网络往返。
  // 分块拼接与对象地址回收由该 hook 负责，本组件只把结果交给正文。
  const bytesState = useWorkflowRunArtifactBytes({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    version,
    enabled: !preset,
  });
  // 看板只让 CLI 取 spec 点名的字段；spec 还没到或画不了时不取数——正文此时本来也画不出图。
  // [权衡] 看板只取 spec 点名的字段，不把整份数据搬进渲染进程。
  // spec 未到或类型画不出图时返回空，条目请求随之关闭。
  const fields = useMemo(
    () =>
      isArtifactPresetKind(artifact.kind)
        ? artifactPresetFieldPaths(artifact.kind, artifact.spec)
        : undefined,
    [artifact.kind, artifact.spec],
  );
  const dataState = useWorkflowRunArtifactData({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    artifactId: artifact.id,
    itemCount: artifact.itemCount,
    enabled: fields !== undefined,
    ...(fields === undefined ? {} : { fields }),
  });

  // 「在工作区显示」与 html 的「在浏览器中打开」共用这一条路径：工作区相对的 `sourcePath`
  // 拼上 workspacePath 才是本机上真实存在的位置。远程 workspace 与无出处的产物都得不到它。
  // 工作区相对出处拼上工作区根目录，才是本机真实路径。
  // 远程会话、无出处、或定位能力不支持时一律留空，按钮随之消失。
  // [失败路径] 留空比猜路径安全，猜错只会给用户一个打不开的目录。
  const sourcePath = artifact.sourcePath;
  const localSourcePath =
    sourcePath !== undefined &&
    canRevealArtifactInWorkspace({
      sourcePath,
      ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
      ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    })
      ? joinFilePath(tab.workspacePath, sourcePath)
      : undefined;

  // 头部只留一个文件控件：能「作为文件打开」时「在工作区显示」收进它的菜单，否则独立成按钮。
  const canOpenAsFile = useCanOpenArtifactAsFile();
  // 能作为文件打开时，在工作区显示收进它的菜单，否则独立成按钮。
  // [事务] 只交属于当前版本的字节，换版那一帧字节还是上一版。
  // 文件副本只写一次，写错版本会让磁盘上留下名实不符的文件。
  const openAsFile = !preset && canOpenAsFile;
  const reveal =
    localSourcePath !== undefined && onRevealFileInTree !== undefined
      ? () => onRevealFileInTree(localSourcePath)
      : undefined;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    // 复制成功只维持 1.5 秒提示态，用定时器自动复位。
    // [资源] 卸载或再次复制时必须清掉旧定时器，否则会向已卸载组件写状态。
    // 清理函数依赖 copied 本身，标记一变就取消上一轮计时。
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  // 复制按钮只在非看板、字节到位、内容为文本三者同时成立时出现。
  // preset、bytes 与 isTextArtifactContentType 缺任一条都直接隐藏按钮，而不是点击后再告知不可复制。
  const copyable =
    !preset && bytesState.bytes !== null && isTextArtifactContentType(artifact.contentType);
  // [失败路径] 剪贴板写入失败静默吞掉，不弹窗也不改文案。
  // 依赖只含字节，保证闭包读到的是当前版本而不是上一版内容。
  // 解码与写入都在微任务里完成，成功后才切到已复制提示。
  const handleCopy = useCallback(() => {
    if (bytesState.bytes === null) return;
    void navigator.clipboard
      ?.writeText(new TextDecoder().decode(bytesState.bytes))
      .then(() => setCopied(true))
      .catch(() => undefined);
  }, [bytesState.bytes]);

  const title = artifactDisplayTitle(artifact);
  const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });

  return (
    <>
      <header className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* 与产物药丸同一枚方形瓦片：tab 头就是那枚药丸长大了。 */}
          <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-surface-hover text-foreground-subtle">
            <ArtifactKindIcon className="size-3.5" kind={artifact.kind} />
          </span>
          <h2
            className="min-w-0 flex-1 truncate text-ui-base font-medium text-foreground"
            data-testid="workflow-artifact-title"
            title={title}
          >
            {title}
          </h2>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-ui-sm text-foreground-subtle">{kindLabel}</span>
          <ArtifactVersionStepper
            availableVersions={availableVersions}
            onSelect={setSelectedVersion}
            version={version}
            versionIndex={versionIndex}
          />
          <div className="ml-auto flex items-center gap-1">
            {openAsFile ? (
              <ArtifactOpenAsFileButton
                artifactId={artifact.id}
                // 只交**属于这一版**的字节：换版本那一帧 bytes 还是旧版的，而副本只写一次。
                bytes={bytesState.bytesVersion === version ? bytesState.bytes : null}
                fileName={artifactOpenAsFileName(artifact, version)}
                runId={tab.runId}
                version={version}
                {...(reveal === undefined ? {} : { onReveal: reveal })}
              />
            ) : null}
            {!openAsFile && reveal !== undefined ? (
              <Button
                data-testid="workflow-artifact-reveal"
                onClick={reveal}
                size="sm"
                type="button"
                variant="ghost"
              >
                <FolderOpenIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.reveal" })}
              </Button>
            ) : null}
            {copyable ? (
              <Button
                data-testid="workflow-artifact-copy"
                onClick={handleCopy}
                size="sm"
                type="button"
                variant="ghost"
              >
                <CopyIcon aria-hidden="true" className="size-3.5" />
                {intl.formatMessage({
                  id: copied
                    ? "chat.toolCall.workflow.run.artifacts.copied"
                    : "chat.toolCall.workflow.run.artifacts.copy",
                })}
              </Button>
            ) : null}
          </div>
        </div>
        {/* 作者写的说明（用户语言）；缺席即整行不渲染。 */}
        {artifact.description === undefined ? null : (
          <p className="mt-1.5 text-ui-sm text-foreground-subtle">{artifact.description}</p>
        )}
      </header>

      <div className="min-h-0 flex-1">
        <WorkflowArtifactBody
          artifact={artifact}
          blob={bytesState.blob}
          bytes={bytesState.bytes}
          error={bytesState.error}
          isLatestVersion={isLatestVersion}
          items={dataState.items}
          loading={bytesState.loading}
          metadataLoading={metadataLoading}
          objectUrl={bytesState.objectUrl}
          resolvedTheme={resolveTheme(theme)}
          theme={theme}
          version={version}
          {...(localSourcePath === undefined ? {} : { localSourcePath })}
          {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
          {...(reveal === undefined ? {} : { onReveal: reveal })}
        />
      </div>
    </>
  );
}

/**
 * 版本步进器 `‹ v2 / 3 ›`。只有一版时整块缺席——一个永远两端禁用的步进器只是噪声。
 *
 * 按**已知版本的数组**翻而不是按数字加减：journal 读不到时数组里只有最新版一个数，
 * 那时步进器自然消失，而不是给出一批取不到字节的版本号。
 */
function ArtifactVersionStepper({
  availableVersions,
  version,
  versionIndex,
  onSelect,
}: {
  availableVersions: readonly number[];
  version: number;
  versionIndex: number;
  onSelect: (version: number) => void;
}) {
  const { intl } = useZCodeIntl();
  if (availableVersions.length <= 1) {
    return (
      <span
        className="font-mono text-ui-xs text-foreground-subtlest"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.version" },
          { version: String(version) },
        )}
      </span>
    );
  }
  const previous = availableVersions[versionIndex - 1];
  const next = availableVersions[versionIndex + 1];
  return (
    <div className="flex items-center gap-0.5" data-testid="workflow-artifact-version-stepper">
      <Button
        aria-label={intl.formatMessage({
          id: "chat.toolCall.workflow.run.artifacts.previousVersion",
        })}
        data-testid="workflow-artifact-version-previous"
        disabled={previous === undefined}
        onClick={() => (previous === undefined ? undefined : onSelect(previous))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      </Button>
      <span
        className="font-mono text-ui-xs text-foreground-subtle"
        data-testid="workflow-artifact-version"
      >
        {intl.formatMessage(
          { id: "chat.toolCall.workflow.run.artifacts.versionOf" },
          { total: String(availableVersions.length), version: String(version) },
        )}
      </span>
      <Button
        aria-label={intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.nextVersion" })}
        data-testid="workflow-artifact-version-next"
        disabled={next === undefined}
        onClick={() => (next === undefined ? undefined : onSelect(next))}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <ChevronRightIcon aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}

/**
 * 一个 dwf 产物的全尺寸查看 tab。
 *
 * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是引擎内部那个
 * 「脚本顶层返回值」的同名词。
 *
 * 数据分三条：**元数据**走 `useWorkflowRunArtifacts`（活投影 + journal 合并），
 * **字节**走 `useWorkflowRunArtifactBytes`（分块拼 Blob），**看板条目**走
 * `useWorkflowRunArtifactData`（`itemCount` 抬升即增量续拉）。三条互不相干，
 * 所以一个看板永远不会去读字节，一份 pdf 也永远不会去翻 journal 的 report 行。
 */
export const WorkflowArtifactSidePane = memo(function WorkflowArtifactSidePane({
  tab,
  onOpenBrowserUrl,
  onRevealFileInTree,
}: {
  tab: WorkflowArtifactSidePaneTab;
  /** html 产物的「在浏览器中打开」。 */
  onOpenBrowserUrl?: (url: string) => void;
  /** 「在工作区显示」：复用既有的文件树 reveal（与 Git 面板同一条路径）。 */
  onRevealFileInTree?: (path: string) => void;
}) {
  // [并发] 作用域由路径、身份、远程会话三者共同决定，缺一不可。
  // 身份用于隔离，路径用于文件操作，远程会话决定走哪条连接。
  // 三者一起进依赖，切工作区时才能整体换掉会话提供者。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowArtifactContent
        tab={tab}
        {...(onOpenBrowserUrl === undefined ? {} : { onOpenBrowserUrl })}
        {...(onRevealFileInTree === undefined ? {} : { onRevealFileInTree })}
      />
    </V4PaneConversationProvider>
  );
});
