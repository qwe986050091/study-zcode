/* eslint-disable max-lines -- Lexical slash 插件的 trigger/面板/键盘导航同属一个协议状态机，oxfmt 换行后略超 400 行。 */
/**
 * SlashCommandPlugin — Lexical trigger 面板插件
 *
 * 处理 `/` 面板里的 slash commands 和 subagents：
 * 1. `/` 直接展示 ZCode Agent 广播的真实 slash commands，并补充可用 subagents
 * 2. 面板通过 portal 渲染到输入区上方的独立挂载层，展开时直接覆盖消息区
 * 3. 支持 Esc 关闭、上下键切换、Enter / Tab 选中，以及跟随输入做模糊搜索
 */
// SlashCommandPlugin — `/` 触发面板的协议状态机：触发词解析、候选合成、键盘导航与提交收尾。
// 职责边界：本文件只维护「输入框里是否存在活跃 `/` token」这一份局部状态，以及由此派生的
// 候选项、选中下标与面板渲染；候选数据全部来自 useSlashCommands / useSubagents / useSkills，
// 命令执行由 appCommands 回调或下游发送链路负责，这里不落库、不改任务状态、不持久化面板开关。
// 也不负责 mention 的序列化格式与命令目录来源，命令目录由 Agent 广播后经 hook 提供。
//
// INV-01 断言：面板打开的唯一判据是 activeTrigger 非空且 disabled 为 false —— 守住它的位置：isOpen 计算与所有 setActiveTrigger(null) 分支 —— 改错故障：禁用态或历史回填时面板残留展开，方向键被吞。
// INV-02 断言：disabled 变 true 后必须同时清空 activeTrigger、selectedIndex 与 activeTokenRef —— 守住它的位置：监听 disabled 的 effect —— 改错故障：重新启用后旧 token 快照让面板误开或选中错项。
// INV-03 断言：带 HISTORY_NAVIGATION_UPDATE_TAG 的编辑器更新不得开启面板 —— 守住它的位置：update listener 开头的 shouldSlashPanelProcessUpdate 判断 —— 改错故障：上翻历史后 CRITICAL 方向键处理器截获后续按键，无法继续翻阅。
// INV-04 断言：dismissedSignature 记录 trigger 与 query 的组合签名而非仅 query —— 守住它的位置：Esc 分支与 nextSignature 比较 —— 改错故障：`/` 关闭后 `@` 的同名查询被同一签名压住，面板打不开。
// INV-05 断言：只有纯选区变化且 token 文本未变时才复用 activeTokenRef 旧快照 —— 守住它的位置：reconcileActivePromptInputTokenSnapshot 的 selectionOnly 入参 —— 改错故障：左右移动光标就重算 query，候选反复重排、选中项跳回。
// INV-06 断言：activeTokenRef 与 activeTrigger 必须同源刷新，不能只更新其中一个 —— 守住它的位置：update listener 中 nextActiveToken 赋值与 setActiveTrigger —— 改错故障：提交时替换区间用旧 token 偏移，删错文字或残留 `/xxx`。
// INV-07 断言：默认选中项按全局模糊评分取最佳，但面板分区顺序保持 commands、skills、subagents —— 守住它的位置：getBestPromptInputSuggestionIndex 与 filteredSuggestions 拼接顺序 —— 改错故障：`/rev` 默认选中 command 而非最佳 subagent，回车选错。
// INV-08 断言：selectedIndex 必须在候选数量收缩时夹紧到 len-1 —— 守住它的位置：监听 filteredSuggestions.length 的 effect —— 改错故障：下标越界后回车无候选可提交，面板看似可用却按不动。
// INV-09 断言：方向键只在候选非空时吞键，Enter/Tab 只在选中成功时吞键 —— 守住它的位置：四个 CRITICAL 键盘处理器 —— 改错故障：空列表时方向键无法移动光标、回车无法换行。
// INV-10 断言：六个编辑器命令必须在 effect cleanup 中逐一注销 —— 守住它的位置：键盘 effect 的 return 清理函数 —— 改错故障：面板关闭后残留 CRITICAL 处理器，输入框永久无法换行。
// INV-11 断言：applySuggestion 内所有 Lexical 读写必须包在 editor.update 回调里 —— 守住它的位置：applySuggestion 的 editor.update —— 改错故障：在 update 外读取选区得到陈旧节点，替换区间错位甚至抛错。
// INV-12 断言：提交后必须写回 setActiveTrigger(null) 与 selectedIndex 0，并清空两个 ref —— 守住它的位置：applySuggestion 的收尾段 —— 改错故障：insertNodes 触发新 update 把面板重新打开，出现幽灵面板。
// INV-13 断言：App 层命令只删除输入中的 `/xxx` token，不插入 mention、不发送消息 —— 守住它的位置：applySuggestion 的 isAppCommand 分支 —— 改错故障：命令被当作普通 mention 插入，发送前多出一条占位文本。
// INV-14 断言：CLI catalog 同名命令优先于 App 命令，且 excludedCommandNames 归一化后过滤 —— 守住它的位置：commandSuggestions 的 useMemo —— 改错故障：App 命令遮蔽 CLI 同名命令，或排除名单因前导斜杠失效。
// INV-15 断言：skills 仅在 trigger 为 `/` 且未 disabled 时请求 —— 守住它的位置：useSkills 的 enabled 入参 —— 改错故障：任何输入都触发技能拉取，产生无谓请求与面板抖动。
// INV-16 断言：workspaceIdentity 必须随 workspacePath 一起透传给三个数据 hook —— 守住它的位置：useSlashCommands / useSubagents / useSkills 调用 —— 改错故障：远程 workspace 落在 path 桶，面板为空。
// INV-17 断言：portal 容器缺失时直接不渲染，且不得自建挂载根 —— 守住它的位置：isOpen 与 container 守卫及 createPortal 第二参数 —— 改错故障：向 null 容器 portal 抛错或产生游离 DOM 层。
//
// 时序：update listener 内先解析 token 再判签名，Esc 写入签名、文本真正变化才清除，
// 顺序颠倒会让「关闭即重开」或「永远打不开」两种症状择一出现。
// 资源：键盘命令与 update listener 均通过 unregister 在 cleanup 释放，portal 复用外部容器。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeProvider } from "@zcode/shared";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $createTextNode,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { useSubagents } from "@/hooks/useSubagents.js";
import { useSkills } from "@/hooks/useSkills.js";
import { buildSlashApplyMentionPayload } from "@/lib/slashApplyMentionPayload.js";
import { filterSkillsForProvider } from "@/lib/skillSourceFilter.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { useSlashCommands } from "./hooks/useSlashCommands.js";
import { $createPromptMentionNode } from "./mentions/nodes/PromptMentionNode.js";
import {
  extractActivePromptInputTrigger,
  filterPromptInputSuggestions,
  getActivePromptInputTokenTailLength,
  getBestPromptInputSuggestionIndex,
  getPromptInputTriggerSignature,
  type ActivePromptInputTrigger,
  type PromptInputSuggestionItem,
} from "./lib/promptInputTriggers.js";
import { MentionPanel } from "./mentions/components/MentionPanel.js";
import {
  buildAppSlashCommandSuggestions,
  buildSkillSuggestions,
  buildSubagentSuggestions,
  buildSlashSuggestions,
  getTextAroundCursor,
  isAppSlashCommandSuggestion,
  normalizeSlashCommandValue,
  type SlashCommandPluginProps,
} from "./slashCommandHelpers.js";
import { useSlashCommandMentionPanelSections } from "./slashCommandPanelSections.js";
import { getCurrentTextNodeSelection } from "./mentions/mentionHelpers.js";
import {
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "./mentions/activePromptInputToken.js";
import { shouldSlashPanelProcessUpdate } from "./lib/slashPanelUpdateFilter.js";

// [契约] 本组件是受控插件：所有状态都收敛在 activeTrigger 与两个签名/快照 ref 中，不向父级回传面板开关。
// props 里的 disabled 来自外部只读或禁用态，必须在所有入口与 effect 中判定，不能只靠 isOpen 一次计算。
// container 是外部提供的 portal 挂载点，缺省时整个组件直接返回 null，绝不回退到 document.body。
// provider 参与 skills 源过滤，workspaceIdentity 参与远程 identity 分桶，两者语义不同不能互相替代。
// 改动前先确认「谁在关闭面板」：Esc、blur、提交、禁用、历史回填五条路径各自负责清哪些 ref。
export function SlashCommandPlugin({
  workspacePath,
  workspaceIdentity,
  sessionId,
  provider,
  container,
  disabled = false,
  excludedCommandNames,
  appCommands,
}: SlashCommandPluginProps & { provider: ZCodeProvider }) {
  const [editor] = useLexicalComposerContext();
  const { intl, locale } = useZCodeIntl();
  const [activeTrigger, setActiveTrigger] = useState<ActivePromptInputTrigger | null>(null);
  // [契约] commands 必须按 workspaceIdentity 读取：远程 workspace 的命令写在 identity 桶，path 桶读不到。
  // workspaceIdentity 为空时 hook 内部回退到 workspacePath，这里不要自己拼 key 或做裁剪。
  // 命令目录由 Agent 的 available_commands_update 推送，面板只读不写，不能在此处补默认命令。
  // commands 变化会重建 commandSuggestions，若发现面板闪动先查 hook 是否返回了新数组引用。
  // 远程 workspace 的 slashCommands 写在 workspaceIdentity 桶。
  // 这里只按 workspacePath 读取会落到 path 桶，表现为 ZCode Agent 已收到 available_commands_update 但 / 面板为空。
  const commands = useSlashCommands(workspacePath, workspaceIdentity);
  const {
    agents,
    loading: subagentsLoading,
    error: subagentsError,
  } = useSubagents(workspacePath, provider, workspaceIdentity);
  const {
    skills,
    loading: skillsLoading,
    error: skillsError,
  } = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId: sessionId ?? null,
    enabled: !disabled && activeTrigger?.trigger === "/",
  });
  // [契约] selectedIndex 是合并后 filteredSuggestions 的下标，不是分区内下标，跨分组导航全靠这一份全局下标。
  // dismissedSignatureRef 记录用户主动关闭的面板签名，只有 token 文本变化才允许重新弹出。
  // activeSignatureRef 是 Esc 分支的只读镜像：键盘处理器闭包拿不到最新 state，必须走 ref。
  // activeTokenRef 保存 token 的字符区间与节点 key，提交时优先用它算替换范围，避免重算漂移。
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dismissedSignatureRef = useRef<string | null>(null);
  const activeSignatureRef = useRef<string | null>(null);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  // [权衡] CLI 命令与 App 命令合并时 CLI 优先：同名命令保留 CLI 版本，App 版本被丢弃。
  // excludedCommandNames 先归一化去前导斜杠再比较，否则 `/init` 与 `init` 会被当成两条。
  // 这里的 value 已去掉前导 `/`，面板渲染时才补回，不要把两边格式混用。
  // useMemo 依赖必须包含 appCommands、commands、excludedCommandNames，漏一个会拿到陈旧的合并结果。
  const commandSuggestions = useMemo(() => {
    const excluded = new Set((excludedCommandNames ?? []).map(normalizeSlashCommandValue));
    const cliSuggestions = buildSlashSuggestions(commands).filter(
      (item) => !excluded.has(item.value),
    );
    // App 层命令追加在 CLI catalog 之后展示；CLI 已提供同名命令时以 CLI 为准，避免遮蔽。
    const cliValues = new Set(cliSuggestions.map((item) => item.value));
    const appSuggestions = buildAppSlashCommandSuggestions(appCommands ?? []).filter(
      (item) => !cliValues.has(item.value) && !excluded.has(item.value),
    );
    return [...cliSuggestions, ...appSuggestions];
  }, [appCommands, commands, excludedCommandNames]);
  const subagentSuggestions = useMemo(() => buildSubagentSuggestions(agents), [agents]);
  // [契约] skills 先按 provider 过滤再按 enabled 过滤，顺序颠倒会把不可用技能算进空态统计。
  // locale 参与技能描述映射，切换语言必须重算，不能依赖 skills 引用是否变化。
  // 这里只产出候选，不触发额外拉取；加载与错误态由 useSkills 的 loading/error 直接进面板分区。
  const skillSuggestions = useMemo(
    () =>
      buildSkillSuggestions(
        filterSkillsForProvider(skills, provider).filter((skill) => skill.enabled),
        locale,
      ),
    [locale, provider, skills],
  );
  const filteredCommandSuggestions = useMemo(
    () => filterPromptInputSuggestions(commandSuggestions, activeTrigger?.query ?? null),
    [commandSuggestions, activeTrigger?.query],
  );
  const filteredSubagentSuggestions = useMemo(
    () => filterPromptInputSuggestions(subagentSuggestions, activeTrigger?.query ?? null),
    [subagentSuggestions, activeTrigger?.query],
  );
  const filteredSkillSuggestions = useMemo(
    () => filterPromptInputSuggestions(skillSuggestions, activeTrigger?.query ?? null),
    [skillSuggestions, activeTrigger?.query],
  );
  const filteredSuggestions = useMemo(
    () => [
      ...filteredCommandSuggestions,
      ...filteredSkillSuggestions,
      ...filteredSubagentSuggestions,
    ],
    [filteredCommandSuggestions, filteredSkillSuggestions, filteredSubagentSuggestions],
  );
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );
  const isOpen = !disabled && activeTrigger !== null;

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    // [权衡] 面板分区必须保持 commands、skills、subagents 的稳定顺序，选中项却要跨分组取全局最优。
    // 若改回「默认选中第一项」，`/rev` 会命中 command 描述里的弱匹配，subagent 永远选不中。
    // 依赖里放 activeSignature 而不是 activeTrigger 对象，避免同 query 的新对象触发无谓重排。
    // 此 effect 不修改 filteredSuggestions，排序与过滤的职责仍在 filterPromptInputSuggestions。
    // 面板展示需要保留 commands/subagents 分组顺序，但键盘默认选中不能固定落在第一个分组。
    // 例如 `/rev` 时 command 描述里的弱匹配可能排在 subagent 分组前面，导致无法默认选中最佳 subagent。
    // 这里按统一的模糊评分选择全局最佳项，同时不改变面板的分组展示顺序。
    setSelectedIndex(
      getBestPromptInputSuggestionIndex(filteredSuggestions, activeTrigger?.query ?? null),
    );
  }, [activeSignature, activeTrigger?.query, filteredSuggestions]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (filteredSuggestions.length === 0) {
        return 0;
      }
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    // [失败路径] 进入禁用态要三清：触发器、选中下标、token 快照；只清 UI 会留下过期快照。
    // 此处依赖数组只有 disabled，不要在内部读取 activeTrigger，否则会多出一次不必要的清空。
    // 禁用结束后不会自动恢复面板，必须等下一次真实输入更新重新解析 token，这是有意的。
    if (!disabled) {
      return;
    }

    setActiveTrigger(null);
    setSelectedIndex(0);
    activeTokenRef.current = null;
  }, [disabled]);

  useEffect(() => {
    // [契约] update listener 是面板唯一的开启入口：任何输入变化都在这里重新解析触发词。
    // editorState.read 内只做同步读取，除 setState 外不产生副作用，也不要调用 editor.update 造成嵌套。
    // [并发] 先判历史导航 tag 再判 disabled：历史回填时立刻关面板，防止 CRITICAL 方向键截获翻阅。
    // cursorText 取不到（选区非折叠或多节点）时按关闭处理，并清空 dismissedSignature 以便下次重开。
    // 回调里的 dirtyElements/dirtyLeaves 只用于判断是否为纯选区变化，不要用来推断文本内容。
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      editorState.read(() => {
        // 历史导航回填含 / 的历史条目时，不应重新打开 slash 面板，
        // 否则面板以 COMMAND_PRIORITY_CRITICAL 注册方向键处理器，吞掉后续历史翻阅按键。
        if (!shouldSlashPanelProcessUpdate(tags)) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        if (disabled) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        // selectionState 为空表示没有文本节点选区，此时退回纯文本前后缀解析，仍拿不到就直接关闭。
        // 注意这里不清 dismissedSignature：只有真正解析不到 token 时才清，避免误伤 Esc 的抑制状态。
        const selectionState = getCurrentTextNodeSelection();
        const cursorText = selectionState ?? getTextAroundCursor();
        if (!cursorText) {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }

        // [并发] 纯选区变化（dirty 集合为空）时复用旧快照，避免左右移动光标就重算 query 导致候选重排。
        // [契约] reconcile 返回 null 表示光标已离开 token，必须按「无触发器」处理，不能回退到文本解析。
        // 非纯选区变化（有实际编辑）时重新生成快照，tokenStart 与 tokenEnd 会随文本一起更新。
        // nextActiveToken 只在这里赋值给 ref；后续触发器判定失败的分支要先清 ref 再关闭面板。
        const nextActiveToken = selectionState
          ? reconcileActivePromptInputTokenSnapshot(
              activeTokenRef.current,
              selectionState,
              dirtyElements.size === 0 && dirtyLeaves.size === 0,
            )
          : null;
        const nextActiveTrigger = selectionState
          ? nextActiveToken
          : extractActivePromptInputTrigger(cursorText.textBeforeCursor);
        if (!nextActiveTrigger || nextActiveTrigger.trigger !== "/") {
          activeTokenRef.current = null;
          dismissedSignatureRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextActiveToken;

        // 签名由 trigger 与 query 组成：先按新签名清除失效的 dismissed 记录，再判断是否仍处于关闭态。
        // 顺序不能反：先判 dismissed 再清，会在用户继续输入时把面板永久压住。
        // [失败路径] 若发现 Esc 后无法再打开，先检查这里是否漏了 nextSignature 的比较。
        const nextSignature = getPromptInputTriggerSignature(nextActiveTrigger);
        if (
          dismissedSignatureRef.current !== null &&
          dismissedSignatureRef.current !== nextSignature
        ) {
          dismissedSignatureRef.current = null;
        }

        if (dismissedSignatureRef.current === nextSignature) {
          setActiveTrigger(null);
          return;
        }

        // 用函数式更新保留同一 trigger 与 query 的旧对象引用，避免无意义重渲染与键盘 effect 重注册。
        // 返回 current 时 React 会跳过更新；若改成直接 set，面板每次按键都会重建命令处理器。
        setActiveTrigger((current) => {
          if (
            current?.trigger === nextActiveTrigger.trigger &&
            current.query === nextActiveTrigger.query
          ) {
            return current;
          }

          return nextActiveTrigger;
        });
      });
    });
  }, [disabled, editor]);

  // [契约] applySuggestion 的所有 Lexical 读写都在 editor.update 内完成，保证选区与节点处于同一编辑事务。
  // selectionState 为空说明选区已失效，直接返回而不是兜底插到末尾，避免把 mention 插错位置。
  // snapshotRange 命中时优先用快照区间，未命中才按光标前缀重算，防止偏移导致删除范围错位。
  // tokenEnd 还要吃掉光标后的同名尾巴，tail 长度由 getActivePromptInputTokenTailLength 计算。
  // [权衡] 提交后统一清空 ref 与 dismissed 签名，是为了让下一次输入从干净状态重新判断。
  const applySuggestion = useCallback(
    (suggestion: PromptInputSuggestionItem) => {
      const isAppCommand = isAppSlashCommandSuggestion(suggestion);
      editor.update(() => {
        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          return;
        }

        const snapshotRange = getActivePromptInputTokenReplacementRange(
          activeTokenRef.current,
          selectionState,
        );
        const activeSlashTrigger = snapshotRange
          ? activeTokenRef.current
          : extractActivePromptInputTrigger(selectionState.textBeforeCursor);
        if (!activeSlashTrigger || activeSlashTrigger.trigger !== "/") {
          return;
        }

        // tokenStart 回退到「光标减 query 长度再减 1」时，那个 1 是触发符本身，漏掉会留下一个孤立 `/`。
        // tokenEnd 的回退分支必须加 tail 长度，否则在词中间回车会留下半截命令文本。
        // [失败路径] 若出现选中后残留字符，优先核对这两个偏移与快照是否同源。
        const tokenStart =
          snapshotRange?.start ?? selectionState.cursorOffset - activeSlashTrigger.query.length - 1;
        const tokenEnd =
          snapshotRange?.end ??
          selectionState.cursorOffset +
            getActivePromptInputTokenTailLength(
              activeSlashTrigger,
              selectionState.textAfterCursor,
              suggestion.value,
            );
        selectionState.selection.setTextNodeRange(
          selectionState.node,
          tokenStart,
          selectionState.node,
          tokenEnd,
        );

        // [契约] App 命令「选中即执行」：只 removeText 掉 `/xxx`，不插入 mention、不触发发送。
        // removeText 必须在已设置好的 setTextNodeRange 之后调用，否则删的是旧选区。
        // 执行回调放在 editor.update 之外，避免在事务中进行可能引发嵌套更新的业务操作。
        // [资源] 回调前先 editor.focus，防止新开的辅助对话抢焦点；这一步不能挪到 requestAnimationFrame。
        if (isAppCommand) {
          // App 层命令"选中即执行"：只移除输入中的 `/xxx` token，不插入 mention、不发送。
          selectionState.selection.removeText();
          return;
        }

        // [契约] 普通命令插入 mention 节点并补一个空格：空格是分隔符，删掉会让后续文字并入 mention。
        // selectEnd 把光标移到空格之后，用户继续输入不会粘在 mention 上。
        // mention 载荷由 buildSlashApplyMentionPayload 统一构造，这里不要手写 markdown 或分类字段。
        const mentionNode = $createPromptMentionNode(buildSlashApplyMentionPayload(suggestion));
        const trailingWhitespace = $createTextNode(" ");
        selectionState.selection.insertNodes([mentionNode, trailingWhitespace]);
        trailingWhitespace.selectEnd();
      });

      dismissedSignatureRef.current = null;
      activeTokenRef.current = null;
      setActiveTrigger(null);
      setSelectedIndex(0);
      if (isAppCommand) {
        // 本地操作也要保留输入焦点；在执行回调前恢复，避免抢走回调新开的辅助对话焦点。
        editor.focus();
        appCommands
          ?.find((command) => normalizeSlashCommandValue(command.value) === suggestion.value)
          ?.run();
        return;
      }
      // [并发] 非 App 命令在下一帧再 focus，等待 React 提交与 portal 收尾，立即聚焦会被面板卸载打断。
      // App 命令则走同步 focus，两条路径顺序不同是有意的，不要合并成一个统一的延迟聚焦。
      requestAnimationFrame(() => {
        editor.focus();
      });
    },
    [appCommands, editor],
  );

  const selectSuggestion = useCallback(
    (index: number) => {
      const suggestion = filteredSuggestions[index];
      if (!suggestion) {
        return false;
      }

      applySuggestion(suggestion);
      return true;
    },
    [applySuggestion, filteredSuggestions],
  );

  useEffect(() => {
    // [契约] 键盘命令只在面板打开时注册；关闭时完全不占用编辑器的事件链。
    // 全部用 COMMAND_PRIORITY_CRITICAL：低于该优先级时 Lexical 默认行为会先移动光标或换行。
    // 依赖包含 filteredSuggestions.length 与 selectedIndex，长度变化会重注册以拿到最新闭包。
    // [资源] 这里注册六个命令，数量与 cleanup 中的注销一一对应，新增命令必须同步补注销。
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredSuggestions.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (filteredSuggestions.length === 0) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // [契约] Enter 与 Tab 只在选中有结果时返回 true；否则返回 false 放行默认换行与缩进。
    // selectSuggestion 内部已判断下标越界，这里不要重复取建议，避免下标与列表不同步。
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (!selectSuggestion(selectedIndex)) {
          return false;
        }

        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();

        // [契约] Esc 只关闭当前 token 的面板并记录签名，不删除输入、不移动光标。
        // 签名必须存 trigger 与 query 组合：只存 query 会让 `/` 与 `@` 的同名查询互相压制。
        // Esc 同时清 selectedIndex，重开时由最佳评分重新定位，沿用旧下标可能越界。
        // [失败路径] 若 Esc 后继续输入仍不弹面板，检查 activeSignatureRef 是否被写入了过期签名。
        // 如果 Esc 关闭后只记 query，不区分 `/` 和 `@`，两个触发器同名查询会互相把面板压住。
        // 这里保存 trigger + query 组合签名，只有当前 token 真正变化后才重新打开，避免一关闭就立刻弹回。
        dismissedSignatureRef.current = activeSignatureRef.current;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    // [失败路径] blur 必须清掉 dismissedSignature，否则失焦再聚焦后同一 token 永远打不开面板。
    // 这里返回 false 表示不消费事件，让编辑器与其他 blur 监听继续处理。
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedSignatureRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    // [资源] 六个 unregister 缺一不可；漏掉任意一个都会让 CRITICAL 处理器在面板关闭后残留。
    // cleanup 与注册顺序对称书写，改动注册条件时同步调整这里的注销集合。
    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, filteredSuggestions.length, isOpen, selectSuggestion, selectedIndex]);

  const panelTitle = intl.formatMessage({ id: "chat.slash.title" });
  const hasActiveQuery = (activeTrigger?.query ?? "").trim().length > 0;
  const panelDescription = hasActiveQuery
    ? ""
    : intl.formatMessage({ id: "chat.slash.searchHint" });

  // 分区实参与顺序固定：commands、skills、subagents 各带 loading 与 error，错位会把错误态挂到别的分组。
  // commands.length 单独传入用于空态判断，不能用 filteredCommandSuggestions 的长度代替。
  // 该 hook 只做展示投影，不参与选中逻辑；selectedIndex 始终指向合并后的 filteredSuggestions。
  const panelSections = useSlashCommandMentionPanelSections(
    intl,
    commands.length,
    filteredCommandSuggestions,
    filteredSkillSuggestions,
    skillsLoading,
    skillsError,
    filteredSubagentSuggestions,
    subagentsLoading,
    subagentsError,
  );

  // [契约] isOpen 与 container 同时满足才渲染；container 缺失直接返回 null，不回退到 document.body。
  // panelTitle 与 panelDescription 在上面按 intl 计算，有查询时描述为空，避免与结果列表抢空间。
  if (!isOpen || !container) {
    return null;
  }

  return createPortal(
    <MentionPanel
      title={panelTitle}
      description={panelDescription}
      trigger="/"
      sections={panelSections}
      emptyText=""
      selectedIndex={selectedIndex}
      hasActiveQuery={hasActiveQuery}
      onSelect={selectSuggestion}
    />,
    container,
  );
}
