// dwf 运行态镜像的 TUI 控制器（与 useSidebarController / useInputHistory 同一 hook 惯例）。
//
// 只管状态与派生：镜像本体、卡片联接表、展开集合。会话事件的接线留在 app.tsx
// （订阅要拿到 applySessionEvent，而后者反过来要拿本 hook 的 setter，放一起会绕成环）。
import React from "react";
import type { TuiCopy } from "@zcode/i18n";
import type { WorkflowRunProgressEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { Message } from "./app-model.js";
import type { TuiOptions } from "./types.js";
import { useWorkflowRunSeeding } from "./app-workflow-seed.js";
import {
  EMPTY_TUI_WORKFLOW_MIRROR,
  applyWorkflowProgressToMirror,
  buildTuiWorkflowCardIndex,
  type TuiWorkflowCard,
  type TuiWorkflowMirror,
  seedWorkflowMirror,
  type TuiWorkflowRunSeed,
} from "./app-workflow-mirror.js";

/** `+`/`-` 的展开控制面。挂在一个对象上是为了让 app.tsx 只多传一个 prop。 */
export type TuiWorkflowExpansionControls = {
  /** 至少有一张卡时才允许吃掉 `+`/`-`——否则那两个键必须照常打进草稿。 */
  hasCards: boolean;
  expandAll: () => void;
  collapseAll: () => void;
};

type TuiWorkflowRunsController = {
  mirror: TuiWorkflowMirror;
  setMirror: React.Dispatch<React.SetStateAction<TuiWorkflowMirror>>;
  cardsByToolCallId: ReadonlyMap<string, TuiWorkflowCard>;
  expandedRunIds: ReadonlySet<string>;
  toggleExpansion: (runId: string) => void;
  seed: (seeds: readonly TuiWorkflowRunSeed[]) => void;
  expansion: TuiWorkflowExpansionControls;
};

// workflow 运行态控制器 hook：维护镜像本体、toolCallId 联接表与展开集合，并桥接冷启动补种/回放。
// 输入 copy/options/setMessages 由 app.tsx 注入；镜像更新后自动重建 cardsByToolCallId（useMemo）。
// 口径：展开态只存于本地临时交互状态；卡片是否存在以联接表为准，hasCards 为 false 时不吞 +/- 键。
// 副作用：挂载时可能发起一次回放与一次列表查询；失败被内部吞掉，不阻塞 TUI 启动。
export function useTuiWorkflowRuns(input: {
  copy: TuiCopy;
  options: TuiOptions;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
}): TuiWorkflowRunsController {
  const [mirror, setMirror] = React.useState<TuiWorkflowMirror>(EMPTY_TUI_WORKFLOW_MIRROR);
  const [expandedRunIds, setExpandedRunIds] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  const cardsByToolCallId = React.useMemo(() => buildTuiWorkflowCardIndex(mirror), [mirror]);

  const toggleExpansion = React.useCallback((runId: string) => {
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);

  // 冷补种只搬展示名（label / updatedAt）。运行态走下面的回放：journal 的**真实、有序**事件
  // 经同一个 reducer 归约——「绝不把摘要合成事件喂给 reducer」的禁令针对的是乱序合成，
  // 对按 sequence 重放的引擎事件不成立。
  const seed = React.useCallback((seeds: readonly TuiWorkflowRunSeed[]) => {
    setMirror((current) => seedWorkflowMirror(current, seeds));
  }, []);
  const replay = React.useCallback((envelopes: readonly WorkflowRunProgressEnvelope[]) => {
    setMirror((current) => envelopes.reduce(applyWorkflowProgressToMirror, current));
  }, []);
  const mirrorRef = React.useRef(mirror);
  mirrorRef.current = mirror;
  const knownRunIds = React.useCallback(
    () => new Set(mirrorRef.current.state.runs.map((run) => run.runId)),
    [],
  );

  // 展开/收起全部：TUI 刻意没有卡片选择机制（无面板、无光标），所以 `+`/`-` 只能作用于全体。
  const runIdsKey = [...cardsByToolCallId.values()].map((card) => card.runId).join("\u0000");
  const expandAll = React.useCallback(() => {
    setExpandedRunIds(new Set(runIdsKey.length === 0 ? [] : runIdsKey.split("\u0000")));
  }, [runIdsKey]);
  const collapseAll = React.useCallback(() => setExpandedRunIds(new Set<string>()), []);

  // 挂载时补种一次并打 interrupted notice；无轮询（第二时钟是 legacy 面板的反面教材）。
  useWorkflowRunSeeding({
    copy: input.copy,
    ...(input.options.listWorkflowRuns === undefined
      ? {}
      : { listWorkflowRuns: input.options.listWorkflowRuns }),
    ...(input.options.replayWorkflowRuns === undefined
      ? {}
      : { replayWorkflowRuns: input.options.replayWorkflowRuns }),
    knownRunIds,
    replay,
    seed,
    setMessages: input.setMessages,
  });

  return {
    mirror,
    setMirror,
    cardsByToolCallId,
    expandedRunIds,
    toggleExpansion,
    seed,
    expansion: { hasCards: cardsByToolCallId.size > 0, expandAll, collapseAll },
  };
}
