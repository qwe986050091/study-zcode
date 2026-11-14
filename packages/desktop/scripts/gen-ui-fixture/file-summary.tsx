// INV-01 固定 rowId：守住位置 rowId: 2 与 rowId: 1；改错故障 预览卡与摘要面板对不上同一行。
// INV-02 turnId 两侧一致：守住位置 两处 "summary-turn"；改错故障 文件变更聚合去别的轮次找。
// INV-03 行类型不可换：守住位置 kind: "assistantText"；改错故障 预览 hook 收到未知类型直接跳过。
// INV-04 文案三态由 mode 决定：守住位置 文本三元；改错故障 only 与 mixed 两个场景互相串扰。
// INV-05 visualize 指令必须带 path：守住位置 JSON.stringify({ path })；改错故障 面板解析不到目标文件。
// INV-06 useMemo 依赖完整：守住位置 [mode, path, root]；改错故障 切换场景后仍渲染旧文案。
// INV-07 workspacePath 与 root 同源：守住位置 workspacePath: root；改错故障 路径拼出双层根目录。
// INV-08 变更条数随 mode 变化：守住位置 两处展开判断；改错故障 ordinary 场景仍报两个文件。
// INV-09 汇总计数与明细同源：守住位置 additions 三元；改错故障 面板总数与列表行数矛盾。
// INV-10 变更目标指向 header：守住位置 fileChangesTarget 的 rowId: 1；改错故障 变更卡片挂到文本行。
// INV-11 预览容器 id 稳定：守住位置 #file-preview-cards；改错故障 截图脚本选择器失效。
// INV-12 摘要面板 id 稳定：守住位置 #file-summary-panel；改错故障 端到端用例无法定位面板。
// INV-13 compact 只影响展示：守住位置 compactForRemoteControl；改错故障 夹具改变数据形态。
// INV-14 上下文集中构造：守住位置 context 对象；改错故障 各子组件读不同来源设置。
//
// 模块职责：为文件预览卡与文件摘要面板提供可复现的最小 UI 夹具。
// 阅读顺序：先看 mode 与 row 的构造，再看 context 与 header 的配套，最后看渲染结构。
import { useMemo } from "react";
import type { AssistantTextRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";

// [边界] FileSummaryFixture 仅供 gen-ui-fixture 截图与端到端用例使用，入口不在生产构建里。
export function FileSummaryFixture({
  path,
  root,
  mode,
  compact,
}: {
  path: string;
  root: string;
  mode: "only" | "mixed" | "ordinary";
  compact: boolean;
}) {
  // 行对象在依赖变化时才重建。
  const row = useMemo<AssistantTextRow>(
    () => ({
      rowId: 2,
      entityId: "summary-text",
      turnId: "summary-turn",
      createdAt: 2,
      createdAtSeq: 2,
      // 行类型必须与 hook 期望一致。
      kind: "assistantText",
      state: "complete",
      // 三种 mode 分别产出纯文件、指令加文件、纯指令文案。
      text:
        mode === "ordinary"
          ? `${root}/demo.html`
          : `::visualize${JSON.stringify({ path })}\n[可视化](${path})${mode === "mixed" ? `\n${root}/demo.html` : ""}`,
    }),
    [mode, path, root],
  );
  // 包成同类行列表，满足 hook 的入参约定。
  const rows = useMemo(() => [row], [row]);
  // 上下文集中构造，两块 UI 读到同一份设置。
  const context = useMemo(
    () => ({
      workspacePath: root,
      // 固定远端身份，夹具不依赖本机路径。
      workspaceIdentity: "ssh:fixture:/workspace",
      workspaceRemoteSessionId: "remote-1",
      theme: "system" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      compactForRemoteControl: compact,
      // 变更清单按 mode 组合，与 header 计数保持一致。
      fetchFileChanges: async () => ({
        items: [
          ...(mode !== "ordinary" ? [{ path, additions: 70, deletions: 1, patches: [] }] : []),
          ...(mode !== "only"
            ? [{ path: `${root}/demo.html`, additions: 7, deletions: 2, patches: [] }]
            : []),
        ],
      }),
    }),
    [compact, mode, path, root],
  );
  // header 代表轮次汇总，预览卡按 rowId 反查它。
  const header: TurnHeaderRow = {
    rowId: 1,
    entityId: "summary-header",
    turnId: "summary-turn",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1,
    // 汇总计数必须与明细列表同源。
    fileChanges: {
      files: mode === "mixed" ? 2 : 1,
      additions: mode === "ordinary" ? 7 : mode === "mixed" ? 77 : 70,
      deletions: mode === "ordinary" ? 2 : mode === "mixed" ? 3 : 1,
      state: "active",
    },
  };
  // 预览卡由 hook 从文本解析得出。
  const cards = useAssistantPreviewCardsForAssistantTextRow({
    row,
    assistantTextRows: rows,
    latestAssistantTextRow: row,
    ...context,
    // 把变更目标显式指向 header 行。
    fileChangesTarget: { rowId: 1, entityId: "summary-header" },
    fileChangesState: "active",
  });
  // 渲染两块区域，各自带稳定 id 供测试定位。
  return (
    <div id="file-summary-fixture">
      <div id="file-preview-cards">
        <AssistantPreviewCards cards={cards} {...context} />
      </div>
      <div id="file-summary-panel">
        <ConversationFileSummaryPanel header={header} context={context} assistantText={row.text} />
      </div>
    </div>
  );
}
