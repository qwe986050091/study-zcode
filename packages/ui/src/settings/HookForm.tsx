/* eslint-disable max-lines -- Hook 表单集中维护 runner 类型、Scope 与高级兼容字段。 */
// HookForm —— 设置页 Hooks 分组的新增 / 编辑 / 删除共用表单。
// 职责：把 props.hook 的已保存快照投影成可编辑草稿，校验后组装完整 HookConfig 交给 onSave。
// 边界：不负责持久化、不解析 Scope 目录、不做 Hook 命中判定与执行，也不感知保存请求是否成功。
// 分层：草稿态由本地 state 独占，已保存值只读，用户点保存之前的输入都不影响 props.hook。
// 取消语义：onCancel 由上层丢弃本组件实例，草稿随之消失，不与服务端做二次对齐。
//
// INV 表（按优先级排列，越靠前越不允许破坏）：
// INV-01 断言：命令去空格后为空则不允许提交 —— 守住它的位置：可用性组合与保存回调首行守卫 —— 改错故障：空命令 Hook 落盘，运行时拉起空进程。
// INV-02 断言：非法 JSON 只报错、绝不覆盖用户原文 —— 守住它的位置：保存分支的异常处理与结构判断 —— 改错故障：正在编辑的长文本被清空，输入丢失。
// INV-03 断言：自定义配置只接受普通对象，数组与标量一律拒绝 —— 守住它的位置：渲染期合法判断与保存期结构判断 —— 改错故障：执行侧拿到非对象配置，读取键时报错。
// INV-04 断言：自定义文本非法时保存按钮保持禁用 —— 守住它的位置：可用性组合结果 —— 改错故障：按钮可点但保存必然失败，用户误以为已保存。
// INV-05 断言：保存失败不清空任何草稿字段 —— 守住它的位置：保存回调的提前退出分支 —— 改错故障：用户需重填全部字段，长命令尤其难恢复。
// INV-06 断言：进程型与命令型两种运行类型的字段互斥 —— 守住它的位置：提交对象的条件展开 —— 改错故障：配置里同时出现参数与外壳，执行侧行为不确定。
// INV-07 断言：参数按行拆分并逐项去空格、丢弃空行 —— 守住它的位置：提交对象里的参数拼接 —— 改错故障：空参数被当成合法实参传入，命令多出空位置。
// INV-08 断言：超时解析失败回退 60 —— 守住它的位置：提交对象里的数值解析 —— 改错故障：非数值进入配置，Hook 超时策略失效。
// INV-09 断言：层级只由本地层级与选中作用域键合成，不反向写回 —— 守住它的位置：作用域菜单的选择回调 —— 改错故障：表单与设置页作用域不同步，Hook 写错文件。
// INV-10 断言：已保存的 Hook 不允许在表单内切换作用域 —— 守住它的位置：作用域菜单的禁用条件 —— 改错故障：同一 Hook 被写到另一层级，出现重复或丢失。
// INV-11 断言：事件与运行类型只能取枚举值 —— 守住它的位置：两个受控下拉 —— 改错故障：自由文本进入配置，执行侧无法路由。
// INV-12 断言：编辑保留原启用状态，新建默认启用 —— 守住它的位置：提交对象里的启用字段 —— 改错故障：编辑一次后停用的 Hook 被悄悄重新启用。
// INV-13 断言：匹配器与状态文案空白时写未设置而非空串 —— 守住它的位置：提交对象里的空值折叠 —— 改错故障：匹配器变成空串后命中所有工具。
// INV-14 断言：删除只把快照透传给上层 —— 守住它的位置：删除按钮的点击回调 —— 改错故障：本层自作主张清空表单或二次确认，删除语义分叉。
//
// 并发：本组件没有请求生命周期，连点保存会产生多次 onSave，去重与幂等由上层负责。
// 资源：渲染期每次输入都会解析一次自定义文本，输入越长成本越高，不做缓存。
// 权衡：用多个独立 state 而非单表单对象，换取字段级更新，代价是依赖数组需逐项维护。
// TSX：注释只能落在语句或表达式边界，不进 JSX 子节点，也不夹在开标签属性行之间。
// 文案：全部走 intl 的 settings.hooks 词条，新增字段不补词条会在界面暴露裸 id。
// 可访问性：每个字段标签通过 htmlFor 绑定输入控件，新增字段必须带上稳定 id。
// 测试锚点：根容器带 hooks-form 测试标识，事件与类型下拉的 id 固定，供端到端用例定位。
import { useCallback, useState, type ReactNode } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import type { Hook, HookConfig, HookEvent, HookType } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { PluginScopeMenu, getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";

// [契约] 入参分为三类：hook 是只读的已保存快照，Scope 相关为受控入参，回调用于把结果交给上层。
// [契约] onSave 是唯一出口，接收组装完成的 HookConfig；onCancel 与 onDelete 都不改动本地草稿。
// [契约] isEditing 只决定标题文案，不参与校验、不改变字段可见性。
// [权衡] workspaceAvailable 为假时层级强制回落 user，避免在无工作区宿主写入项目级配置。
// [失败路径] 未提供 onScopeKeyChange 时切换作用域只改本地层级，选择结果不回传给上层。
interface HookFormProps {
  hook?: Hook;
  workspaceAvailable?: boolean;
  defaultStorageLevel?: "user" | "project";
  onSave: (config: HookConfig) => void;
  onCancel: () => void;
  onDelete?: (hook: Hook) => void;
  isEditing?: boolean;
  workspaceTabs?: ConfigWorkspaceTarget[];
  selectedScopeKey?: string;
  onScopeKeyChange?: (scopeKey: string) => void;
}

// [契约] 该数组是事件下拉的唯一取值来源，顺序即展示顺序，新增事件必须在此补齐。
// [契约] 默认事件为 PreToolUse，切换事件不会重置其它草稿字段。
// [权衡] 手写字面量换取显式顺序，代价是类型扩展时需要人工同步本数组。
// [失败路径] 历史数据的事件若不在本数组内，下拉受控值找不到对应项而显示空白，提交仍用原值。
const HOOK_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
];

// [契约] custom 为空或空对象时产出空文本，让输入框呈现未填写状态，提交时该字段缺席。
// [事务] 只在表单初始化时序列化一次，之后草稿由用户输入独占，不再被 props 覆盖。
// [权衡] 用两空格缩进便于阅读，代价是保存前的文本与实际存储的紧凑形式存在排版差异。
// [失败路径] 历史数据若不是对象，这里仍会字符串化，合法性交给保存分支判断。
function formatCustomJson(custom?: Record<string, unknown>): string {
  return custom && Object.keys(custom).length > 0 ? JSON.stringify(custom, null, 2) : "";
}

// [契约] 子组件只做 Scope 展示与选择，层级换算交给父级的选择回调。
// [资源] 标题文案取自 settings.scope.label，与表单其它字段共用同一 intl 实例。
// [权衡] 拆出 HookScopeMenu 让文字标签也能触发下拉，牺牲一层 scope 传参换取更大点击区域。
// [失败路径] 禁用态下菜单无法展开，用户只能取消后重新创建 Hook 来更换作用域。
function HookScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.scope.label" })}
      </span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

// [契约] 全部字段值来自本地 state，props.hook 仅在挂载时读取一次作为初值。
// [并发] 组件不做防抖与请求去重，连续点击保存会触发多次 onSave，幂等由调用方保证。
// [失败路径] 编辑对象切换时组件不会重建草稿，需要上层用 key 强制重新挂载。
// [事务] 保存是先全量校验、后一次性提交，不存在部分字段先落盘的中间态。
export function HookForm({
  hook,
  workspaceAvailable = false,
  defaultStorageLevel = "user",
  onSave,
  onCancel,
  onDelete,
  isEditing = false,
  workspaceTabs = [],
  selectedScopeKey,
  onScopeKeyChange,
}: HookFormProps) {
  const { intl } = useZCodeIntl();
  // [契约] 初始层级只看快照中的作用域是否属于项目级，其余取值一律按用户级处理。
  // [权衡] 已保存 Hook 以快照为准，忽略默认层级入参，避免编辑时被默认值意外改写。
  // [事务] 该值只在挂载时算一次，之后的层级变化由层级 state 承接，不回读 props。
  // [失败路径] 快照缺少位置信息时按用户级处理，保存会把该 Hook 写到用户级配置。
  const initialStorageLevel = hook?.location?.scope === "project" ? "project" : "user";
  const [storageLevel, setStorageLevel] = useState<"user" | "project">(
    workspaceAvailable ? (hook ? initialStorageLevel : defaultStorageLevel) : "user",
  );
  // [契约] 兜底作用域键取工作区列表首项，没有工作区时落到 user。
  // [权衡] 只取首个标签而非扫描全部，因为一次编辑只对应一个工作区归属。
  // [事务] 该键只作未受控时的兜底，上层一旦传入选中键就完全接管展示。
  // [失败路径] 列表为空而层级又是项目级时，键回落 user，与层级组合可能被上游校验拒绝。
  const initialWorkspaceKey = workspaceTabs[0] ? getPluginWorkspaceKey(workspaceTabs[0]) : "user";
  const scopeKey = selectedScopeKey ?? (storageLevel === "project" ? initialWorkspaceKey : "user");
  // [契约] 事件、运行类型、匹配器、命令、参数各自独立初始化，互不派生。
  // [事务] 参数在草稿里用换行拼接成多行文本，提交时再拆回数组，展示与存储在此单向转换。
  // [失败路径] 历史参数若不是字符串项，拼接后会被规整成字符串，保存后类型被统一。
  // [权衡] 多行文本编辑换取可读性，代价是无法表达本身含换行的单个参数。
  const [event, setEvent] = useState<HookEvent>(hook?.event ?? "PreToolUse");
  const [type, setType] = useState<HookType>(hook?.type ?? "process");
  const [matcher, setMatcher] = useState(hook?.matcher ?? "");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [args, setArgs] = useState((hook?.args ?? []).join("\n"));
  const [asyncCommand, setAsyncCommand] = useState(hook?.async ?? false);
  const [shell, setShell] = useState(typeof hook?.shell === "string" ? hook.shell : "");
  const [statusMessage, setStatusMessage] = useState(hook?.statusMessage ?? "");
  const [timeout, setTimeout] = useState(String(hook?.timeout ?? 60));
  // [契约] 该文本是 custom 的草稿，与已保存的对象解耦，编辑期间原文保持不变。
  // [资源] 初始化时序列化一次，此后不随渲染重算，避免大对象被反复格式化。
  // [权衡] 让用户直接编辑 JSON 文本，换取对任意结构的支持，代价是自带校验与错误提示。
  // [失败路径] 非法内容不会写回配置，保存被阻断，原文留在输入框里供修正。
  // [契约] 错误提示独立存储，文本变化不会自动清错，只在下次校验全部通过时清除。
  const [customJson, setCustomJson] = useState(formatCustomJson(hook?.custom));
  // [契约] 该错误槽只承载自定义 JSON 的语法错误与结构错误两类文案。
  // [失败路径] 文案在保存尝试时写入，渲染期不产生错误，避免用户输入一半就被标红。
  // [事务] 清除点唯一：校验全部通过、即将提交之前。
  // [权衡] 用单个 customError 换实现简单，多个问题并存时只展示首个。
  const [customError, setCustomError] = useState<string | null>(null);
  // [契约] 空白文本视为合法，等价于不填自定义配置；非空则必须解析成普通对象。
  // [契约] 数组、空值、标量都判非法，与共享类型里该字段的对象形状保持一致。
  // [资源] 判断在渲染期同步执行，每次输入都会解析一次，成本受用户输入长度约束。
  // [失败路径] 解析异常按非法处理，不区分语法与结构问题，具体文案留给保存分支。
  const customJsonValid = (() => {
    if (!customJson.trim()) return true;
    try {
      const parsed = JSON.parse(customJson) as unknown;
      return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    } catch {
      return false;
    }
  })();
  // [契约] 保存可用性只由命令非空与自定义文本合法两点决定，其它字段一律不阻塞。
  // [权衡] 超时等数值字段不参与禁用，改由提交时回退默认值兜底，减少用户被卡住。
  // [失败路径] 按钮禁用时保存回调仍会再判一次命令，防止绕过按钮的触发路径。
  // [契约] 匹配器、状态文案等可空字段为空不影响可用性，提交时折叠为未设置。
  const canSave = Boolean(command.trim() && customJsonValid);

  // [事务] 保存是单事务：先校验命令与自定义文本，再一次性拼出配置，任一步失败都不调用上层回调。
  // [契约] 依赖数组列全参与组装的字段，避免闭包读到旧值，新增字段必须同步加入。
  // [失败路径] 命令为空时静默返回，不写错误提示，因为按钮已由可用性判断禁用。
  // [并发] 回调本身无锁，重复点击会重复提交同一份快照，幂等由上层保证。
  // [权衡] 稳定回调引用减少子组件重渲染，代价是依赖数组需要长期维护。
  const handleSave = useCallback(() => {
    // [契约] 首行守卫：命令去空格后为空即放弃提交，早于任何文本解析。
    // [失败路径] 此处不写错误提示，避免把缺少命令误报成自定义 JSON 的问题。
    // [事务] 提前返回发生在任何状态写入之前，草稿保持原样。
    // [权衡] 静默返回来换取按钮禁用态作为唯一提示源。
    if (!command.trim()) return;

    let custom: Record<string, unknown> | undefined;
    // [契约] 只有文本非空才进入解析，空文本直接跳过，提交时该字段缺席。
    // [事务] 解析成功后先判结构，结构合格才写入待提交变量，保证出口拿到的一定是对象。
    // [失败路径] 语法错误与结构不符是两条独立路径，都写入错误并终止本次保存。
    // [资源] 本次保存只经一次 JSON.parse，渲染期合法性判断不复用该结果。
    if (customJson.trim()) {
      try {
        // [失败路径] 解析结果先按未知类型承接，禁止直接断言成对象，结构校验紧跟其后。
        // [事务] 校验通过后才收窄为对象形状，写入点唯一。
        // [契约] 缩进与换行不影响解析结果，草稿排版差异不会改变存储内容。
        // [权衡] JSON.parse 放在保存时而非输入时，换取打字过程不被报错打断。
        const parsed = JSON.parse(customJson) as unknown;
        // [契约] 合法自定义配置必须是普通对象，空值、数组、字符串、数字一律拒绝。
        // [失败路径] 命中该判断只写结构错误文案，随后退出，不覆盖原文本。
        // [事务] 拒绝发生在写入之前，待提交变量仍是未设置状态。
        // [权衡] 只校验顶层 plain object，嵌套内容原样透传交给执行侧解释。
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonObjectError" }));
          return;
        }
        custom = parsed as Record<string, unknown>;
      } catch {
        // [失败路径] 异常分支只处理语法错误，文案与结构错误分开，便于用户区分修法。
        // [契约] 失败即退出回调，已就绪的事件、类型、命令等字段不会被提前提交。
        // [事务] 原始文本保持不动，用户可原地修正后再次保存。
        // [权衡] 不替用户修补 JSON 尾逗号，换取存储内容与所见严格一致。
        setCustomError(intl.formatMessage({ id: "settings.hooks.customJsonParseError" }));
        return;
      }
    }

    setCustomError(null);
    // [契约] 出口只组装一份配置：事件、类型、命令必填，其余按运行类型与空值裁剪。
    // [契约] 匹配器与状态文案去空格后为空即折叠为未设置，不写空字符串。
    // [事务] 组装后同步调用 onSave，回调返回前不产生持久化副作用。
    // [失败路径] 本组件不感知上层结果，保存失败时草稿保留，用户可直接重试。
    // [资源] 启用状态默认继承快照，新建时落到启用，避免创建后立即处于停用态。
    onSave({
      event,
      matcher: matcher.trim() || undefined,
      type,
      command: command.trim(),
      // [契约] 运行类型决定字段互斥：进程型只带参数，命令型只带异步开关与外壳。
      // [事务] 条件展开保证另一分支的残留字段不会写进配置，切换类型即丢弃。
      // [失败路径] 从命令型切回进程型时，先前填写的开关与外壳不参与提交。
      // [权衡] 用展开代替后置删字段，换取组装表达式的可达性，代价是单行较长。
      ...(type === "process"
        ? {
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
          }
        : {
            // [契约] async 开关只对命令型生效，取值直接来自 asyncCommand 布尔草稿。
            // [失败路径] 关闭时仍显式写入假值，与未设置区分，避免执行侧按默认值误判。
            // [权衡] 布尔与未设置不合并，保持语义精确，代价是配置里可能出现显式假值。
            // [契约] 外壳为空时回退快照里的布尔形态，只有历史数据为真才继续透传。
            async: asyncCommand,
            shell: shell.trim() || (hook?.shell === true ? true : undefined),
          }),
      statusMessage: statusMessage.trim() || undefined,
      timeout: Number.parseInt(timeout, 10) || 60,
      enabled: hook?.enabled ?? true,
      custom,
      storageLevel,
    });
  }, [
    args,
    asyncCommand,
    command,
    customJson,
    event,
    hook?.enabled,
    intl,
    matcher,
    onSave,
    shell,
    statusMessage,
    storageLevel,
    timeout,
    type,
  ]);

  // [契约] 下列 JSX 只做布局与受控绑定，所有取值与回调都来自上面的 state 与 props。
  // [契约] 保存与取消并排在表单动作区，删除作为前置链接动作，与编辑态解耦。
  // [资源] 高级区默认折叠，自定义配置的错误提示就近渲染在文本域下方，不打断主表单流。
  // [权衡] 事件与类型下拉在窄屏占满整行、宽屏固定宽度，兼顾手机宽度与桌面紧凑。
  // [失败路径] 删除入口只在快照与删除回调同时存在时出现，其余情况不渲染该按钮。
  return (
    <div className="space-y-4" data-testid="hooks-form">
      <div className="space-y-1">
        <h3 className="text-ui-xl font-semibold text-foreground">
          {intl.formatMessage({
            id: isEditing ? "settings.hooks.edit" : "settings.hooks.add",
          })}
        </h3>
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.hooks.description" })}
        </p>
      </div>

      <div className="space-y-3 rounded-xl border border-border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid w-full min-w-0 gap-3 sm:grid-cols-2 md:w-auto">
            <Field label={intl.formatMessage({ id: "settings.hooks.event" })} htmlFor="hook-event">
              <Select value={event} onValueChange={(value) => setEvent(value as HookEvent)}>
                <SelectTrigger id="hook-event" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((hookEvent) => (
                    <SelectItem key={hookEvent} value={hookEvent}>
                      {hookEvent}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={intl.formatMessage({ id: "settings.hooks.type" })} htmlFor="hook-runner">
              <Select value={type} onValueChange={(value) => setType(value as HookType)}>
                <SelectTrigger id="hook-runner" size="lg" className="w-full md:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["process", "command"] as const).map((hookType) => (
                    <SelectItem key={hookType} value={hookType}>
                      {intl.formatMessage({
                        id: `settings.hooks.type.${hookType}`,
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <HookScopeMenu
            disabled={Boolean(hook)}
            scopeKey={scopeKey}
            workspaceTabs={workspaceAvailable ? workspaceTabs : []}
            onChange={(nextScopeKey) => {
              setStorageLevel(nextScopeKey === "user" ? "user" : "project");
              onScopeKeyChange?.(nextScopeKey);
            }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={intl.formatMessage({ id: "settings.hooks.matcher" })} htmlFor="matcher">
            <Input
              id="matcher"
              size="lg"
              value={matcher}
              onChange={(event) => setMatcher(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.matcherPlaceholder",
              })}
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.matcherHint" })}
            </p>
          </Field>

          <Field label={intl.formatMessage({ id: "settings.hooks.command" })} htmlFor="command">
            <Input
              id="command"
              size="lg"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.commandPlaceholder",
              })}
              className="font-mono"
            />
          </Field>
        </div>

        {type === "process" ? (
          <Field label={intl.formatMessage({ id: "settings.hooks.args" })} htmlFor="args">
            <SettingsFormTextarea
              id="args"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder={intl.formatMessage({
                id: "settings.hooks.argsPlaceholder",
              })}
              rows={4}
              className="resize-y font-mono"
            />
            <p className="text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "settings.hooks.argsHint" })}
            </p>
          </Field>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={intl.formatMessage({ id: "settings.hooks.shell" })} htmlFor="hook-shell">
              <Input
                id="hook-shell"
                size="lg"
                value={shell}
                onChange={(event) => setShell(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "settings.hooks.shellPlaceholder",
                })}
                className="font-mono"
              />
            </Field>
            <div className="flex items-end justify-between gap-4 pb-1">
              <Label htmlFor="hook-async-command">
                {intl.formatMessage({ id: "settings.hooks.async" })}
              </Label>
              <Switch
                id="hook-async-command"
                checked={asyncCommand}
                onCheckedChange={setAsyncCommand}
              />
            </div>
          </div>
        )}

        <details className="group/advanced border-t border-border pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-ui-base font-medium text-foreground-subtle">
            <ChevronRight
              className="size-3.5 transition-transform group-open/advanced:rotate-90"
              aria-hidden="true"
            />
            {intl.formatMessage({ id: "settings.hooks.advanced" })}
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={intl.formatMessage({ id: "settings.hooks.timeout" })} htmlFor="timeout">
                <Input
                  id="timeout"
                  size="lg"
                  type="number"
                  min={1}
                  value={timeout}
                  onChange={(event) => setTimeout(event.target.value)}
                  className="w-28"
                />
                <p className="text-ui-base text-foreground-subtlest">
                  {intl.formatMessage({ id: "settings.hooks.timeoutHint" })}
                </p>
              </Field>

              <Field
                label={intl.formatMessage({
                  id: "settings.hooks.statusMessage",
                })}
                htmlFor="hook-status-message"
              >
                <Input
                  id="hook-status-message"
                  size="lg"
                  value={statusMessage}
                  onChange={(event) => setStatusMessage(event.target.value)}
                  placeholder={intl.formatMessage({
                    id: "settings.hooks.statusMessagePlaceholder",
                  })}
                />
              </Field>
            </div>

            <Field
              label={intl.formatMessage({ id: "settings.hooks.customJson" })}
              htmlFor="hook-custom-json"
            >
              <SettingsFormTextarea
                id="hook-custom-json"
                value={customJson}
                onChange={(event) => setCustomJson(event.target.value)}
                rows={5}
                className="resize-y font-mono text-ui-base"
                placeholder={'{\n  "customKey": "value"\n}'}
              />
              {customError ? <p className="text-ui-base text-destructive">{customError}</p> : null}
            </Field>
          </div>
        </details>

        <SettingsFormActions
          leadingAction={
            hook && onDelete ? (
              <Button
                type="button"
                variant="link"
                size="lg"
                className="px-0 text-destructive hover:text-destructive"
                onClick={() => onDelete(hook)}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "common.delete" })}
              </Button>
            ) : undefined
          }
        >
          <Button size="lg" onClick={handleSave} disabled={!canSave}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </SettingsFormActions>
      </div>
    </div>
  );
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode;
  htmlFor?: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-foreground-subtle">
        {label}
      </Label>
      {children}
    </div>
  );
}
