// INV-01 两条路按价值排序：守住位置 弹层结构；改错故障 提炼入口被折到次要位置。
// INV-02 提炼路可缺席：守住位置 发送函数判断；改错故障 老宿主渲染出死按钮。
// INV-03 直接保存可缺席：守住位置 不支持标志；改错故障 老 agent 收到未知请求。
// INV-04 远程项目锁项目档：守住位置 锁定标志；改错故障 远端读到不存在的全局目录。
// INV-05 草稿只在打开时定起点：守住位置 惰性初值；改错故障 运行名变化把表单拽回。
// INV-06 关闭即丢弃草稿：守住位置 条件挂载；改错故障 再次打开看到上次残留。
// INV-07 名字探测合并三百二十毫秒：守住位置 防抖常量；改错故障 每键一次磁盘查询。
// INV-08 探测结论随输入作废：守住位置 副作用首行重置；改错故障 旧结论挂到新名字上。
// INV-09 双作用域同时问：守住位置 并发查询；改错故障 保存时才发现遮蔽。
// INV-10 锁档时不问另一档：守住位置 锁定分支；改错故障 远程项目多一次无效往返。
// INV-11 空名字跳过探测：守住位置 早退条件；改错故障 空串被当成已占用。
// INV-12 取消标志防过期回填：守住位置 取消判断；改错故障 旧请求覆盖新结论。
// INV-13 目标已存在先警告：守住位置 目标存在分支；改错故障 直接覆盖用户文件。
// INV-14 覆盖需再次点击：守住位置 覆盖标志透传；改错故障 首次点击即静默覆盖。
// INV-15 说明为空退回名字：守住位置 或运算兜底；改错故障 中枢卡片标题空白。
// INV-16 成功才通知并关闭：守住位置 成功分支；改错故障 失败弹层关闭且无提示。
// INV-17 提炼发送中禁用两路：守住位置 禁用计算；改错故障 重复发送两条消息。
// INV-18 快捷键只触发主路径：守住位置 键位判断；改错故障 回车误触直接保存。
//
// 模块职责：工作流完成卡的保存弹层与两条保存路径的表单状态。
// 状态所有权：草稿、探测结论与失败原因归表单；保存结果由宿主回传。
// 阅读顺序：先看弹层与宿主契约，再读表单初值，最后看探测与提交路径。
// 完成卡「保存」弹层（docs/dynamic-workflow/transcript-and-notifications.md「The popover」）。
//
// 两条路按**价值**排序而不是按成本：先是整条宽的「让 ZCode 帮我提炼保存」，一条细线之下才是
// 「按原样直接保存」的三个字段。刚跑完的脚本是一次性的，把两次运行之间会变的值抽成 args、写清
// 说明与使用时机——这件事只有读过脚本的人能做，所以它排在第一位。
//
// 三个字段服务于两条路：填了什么，既随消息交给 ZCode，也是直接保存要写下去的那一份。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SparkleIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope, ZCodeWorkflowsSaveResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WorkflowSaveFields, type WorkflowSaveFailure } from "./WorkflowSaveFields.js";
import {
  initialWorkflowSaveDraft,
  isValidSavedWorkflowNameText,
  savedWorkflowPathPreview,
  type WorkflowSaveDraft,
} from "./workflowRunSave.js";

/** 占用探测的合并窗：每敲一个字符都查一次磁盘没有意义，人停下来那一刻才有。 */
const NAME_PROBE_DEBOUNCE_MS = 320;

export interface WorkflowSavePopoverHost {
  /** 弹层打开那一刻用来预填名字与说明。 */
  runName?: string;
  /** 老 agent 没有 `workflows/save`：只留 ZCode 那条路。 */
  directSaveUnsupported: boolean;
  /** 远程项目不给全局档：`~` 在 agent 机器上，中枢从不读它。 */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: {
    name: string;
    scope: ZCodeSavedWorkflowScope;
    meta: { description: string };
    overwrite?: boolean;
  }) => Promise<ZCodeWorkflowsSaveResult>;
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  /**
   * 把那条用户消息发出去（宿主各有各的发送路径：卡在本会话，侧板在父会话）。
   * 缺席即这条路不可达——弹层只剩细线之下的那一半。
   */
  sendLead?: (draft: WorkflowSaveDraft) => Promise<void>;
  /** 写成之后：父级据此翻成「再次运行」并播一次 aria-live。 */
  onSaved: (saved: { name: string; scope: ZCodeSavedWorkflowScope }) => void;
}

// anchorRef 用虚拟引用定位，不额外包裹占位节点。
// align=end 让弹层靠右对齐，collisionPadding=8 留 8px 余量。
// className 的 max-w-[calc(100vw-16px)] 让宽度同时受视口上限约束。
// 空白区 onClick 里 stopPropagation，不冒泡成卡片点击。
// 回车与空格在 onKeyDown 里拦截，不向外层传播。
// anchorRef 内部点击不算 outside，不触发 onOpenChange(false)。
export function WorkflowSavePopover({
  anchorRef,
  host,
  onOpenChange,
  open,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowSavePopoverHost;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        // 手机上卡片窄于弹层：离屏幕边留 8px，宽度不超出视口（320px 的屏也放得下）。
        className="w-80 max-w-[calc(100vw-16px)] gap-2.5"
        collisionPadding={8}
        data-testid="workflow-save-popover"
        // 同「配置」弹层：portal 在外、React 事件仍沿组件树冒泡，不拦的话点空白处会被卡当成点卡身。
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        {/* 开着才挂载：草稿的起点因此是**这一次**打开那一刻，关掉即丢弃（Esc 的语义）。 */}
        {open ? <WorkflowSaveForm host={host} onClose={() => onOpenChange(false)} /> : null}
      </PopoverContent>
    </Popover>
  );
}

// draft 的初值只在挂载时算一次，后续重渲染复用。
// runName 只在存在时注入初始名字，缺省留空。
// scopeLocked 时初始 scope 直接落到 project 档。
// 聚焦放在 requestAnimationFrame 之后，避开首次渲染。
// rawDraft 与裁剪后的 name 分开保存，输入过程不丢原文。
// failure 在 name 或 scope 变化时清空，旧错误不留在新输入上。
function WorkflowSaveForm({
  host,
  onClose,
}: {
  host: WorkflowSavePopoverHost;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback((id: string) => intl.formatMessage({ id }), [intl]);
  // 起点在打开那一刻定下（同「配置」弹层）：run 在弹层开着时变了，也不该把用户正在改的表单拽回去。
  const [draft, setDraft] = useState<WorkflowSaveDraft>(() =>
    initialWorkflowSaveDraft({
      ...(host.runName === undefined ? {} : { runName: host.runName }),
      ...(host.scopeLocked ? { scope: "project" as const } : {}),
    }),
  );
  const [probe, setProbe] = useState({ taken: false, shadowing: false });
  const [failure, setFailure] = useState<WorkflowSaveFailure | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // 打开即聚焦名字框（Tab 顺序仍是 lead → 名字 → 作用域 → 说明 → 直接保存）。
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const name = draft.name.trim();
  const nameInvalid = name.length > 0 && !isValidSavedWorkflowNameText(name);
  const canDirectSave =
    !host.directSaveUnsupported && name.length > 0 && !nameInvalid && !host.saving;

  const { checkNameTaken, directSaveUnsupported, scopeLocked } = host;
  const { scope } = draft;
  // 占用探测：合并 320 ms，两个作用域一起问——目标那个决定「覆盖」，另一个决定「遮蔽」。
  // 名字或作用域一变先把结论作废，免得旧答案留在新名字上。
  useEffect(() => {
    setProbe({ taken: false, shadowing: false });
    if (directSaveUnsupported || name.length === 0 || !isValidSavedWorkflowNameText(name)) return;
    let cancelled = false;
    const other: ZCodeSavedWorkflowScope = scope === "global" ? "project" : "global";
    const timer = window.setTimeout(() => {
      void Promise.all([
        checkNameTaken(name, scope),
        // 远程项目只有项目档这一档，另一档问了也没有意义（中枢从不读 agent 机器的 `~`）。
        scopeLocked ? Promise.resolve(false) : checkNameTaken(name, other),
      ]).then(([taken, shadowing]) => {
        if (!cancelled) setProbe({ taken, shadowing });
      });
    }, NAME_PROBE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [checkNameTaken, directSaveUnsupported, name, scope, scopeLocked]);

  const update = (next: Partial<WorkflowSaveDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setFailure(undefined);
  };

  const handleLead = () => {
    if (host.sendLead === undefined || sending || host.saving) return;
    setSending(true);
    void host.sendLead({ ...draft, name }).then(
      () => onClose(),
      () => setSending(false),
    );
  };

  // canDirectSave 为 false 时直接返回，不进入提交流程。
  // 提交前 setFailure(undefined) 清掉上一次失败。
  // description 为空时退回 name 兜底。
  // probe.taken 为 true 才带 overwrite 标志。
  // save() 成功后立即 onClose() 关闭弹层。
  // 目标已存在时 probe.taken 为 true，转为待确认覆盖，不直接写入。
  const handleDirectSave = () => {
    if (!canDirectSave) return;
    setFailure(undefined);
    void host
      .save({
        name,
        scope,
        // 说明空着就退回名字：中枢的卡片上那一行不能是空的。
        meta: { description: draft.description.trim() || name },
        ...(probe.taken ? { overwrite: true } : {}),
      })
      .then(
        (result) => {
          if (result.ok) {
            host.onSaved({ name: result.name, scope: result.scope });
            onClose();
            return;
          }
          // 目标已存在：不是失败，是还没确认过覆盖——把警告摆出来，按钮改成「覆盖并直接保存」。
          if (result.reason === "target_exists") {
            setProbe((current) => ({ ...current, taken: true }));
            return;
          }
          setFailure({
            reason: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          });
        },
        (error: unknown) => {
          setFailure({
            reason: "generic",
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      );
  };

  // name 为空时 pathPreview 用省略号占位。
  // pathPreview 的 useMemo 依赖 name 与 scope，二者变化才重算。
  // submitLabel 随 host.saving 与 probe.taken 切换文案。
  // probe.taken 为 true 时按钮改用覆盖语义的文案。
  const pathPreview = useMemo(
    () => savedWorkflowPathPreview(scope, name.length > 0 ? name : "…"),
    [name, scope],
  );
  const submitLabel = host.saving
    ? format("chat.toolCall.workflow.saveRun.submit.saving")
    : probe.taken
      ? format("chat.toolCall.workflow.saveRun.submit.overwrite")
      : format("chat.toolCall.workflow.saveRun.submit");

  return (
    <div
      className="flex flex-col gap-2.5"
      // `⌘↩` / `Ctrl↩` 从任何一个字段触发那条主路径：弹层的主张就是那一枚钮。
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          handleLead();
        }
      }}
    >
      <PopoverTitle>{format("chat.toolCall.workflow.saveRun.title")}</PopoverTitle>
      {host.sendLead === undefined ? null : (
        <div className="flex flex-col gap-1.5">
          <Button
            className="h-8 w-full"
            data-icon="inline-start"
            data-testid="workflow-save-lead"
            disabled={sending || host.saving}
            onClick={handleLead}
            type="button"
          >
            {sending ? <Spinner className="size-3.5" /> : <SparkleIcon className="size-3.5" />}
            {format(
              sending
                ? "chat.toolCall.workflow.saveRun.lead.sending"
                : "chat.toolCall.workflow.saveRun.lead",
            )}
          </Button>
          <p className="text-ui-sm leading-snug text-foreground-subtle">
            {format("chat.toolCall.workflow.saveRun.lead.hint")}
            {host.directSaveUnsupported
              ? ` ${format("chat.toolCall.workflow.saveRun.lead.unsupported")}`
              : ""}
          </p>
        </div>
      )}
      {host.directSaveUnsupported ? null : (
        <WorkflowSaveFields
          draft={draft}
          failure={failure}
          nameInvalid={nameInvalid}
          nameRef={nameRef}
          onDirectSave={handleDirectSave}
          pathPreview={pathPreview}
          saving={host.saving}
          scopeLocked={host.scopeLocked}
          shadowing={probe.shadowing}
          showDivider={host.sendLead !== undefined}
          submitDisabled={!canDirectSave}
          submitLabel={submitLabel}
          taken={probe.taken}
          update={update}
        />
      )}
    </div>
  );
}
