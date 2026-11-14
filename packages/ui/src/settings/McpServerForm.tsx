// McpServerForm：MCP 服务器新增/编辑表单，承载表单态、JSON 双模式草稿与保存闸门。
// 职责边界：只在本地维护展示与草稿；配置写盘、作用域合并、重名裁决由上层 mcp 设置容器负责。
// 不负责：读写配置文件、连接测试、删除二次确认、列表排序与刷新。
//
// INV-01 断言：表单草稿只保存在组件内部，落盘只经 onSave —— 守住它的位置：handleSaveClick —— 改错故障：出现第二份可写状态，切换编辑对象后旧值回写覆盖新配置。
// INV-02 断言：initialForm 只作为 useState 的初始值被消费 —— 守住它的位置：form 与 jsonDraft 的初始化器 —— 改错故障：重新计算并回写会覆盖用户未保存的输入。
// INV-03 断言：formRef 与 jsonDraftRef 必须与状态同步 —— 守住它的位置：两个快照同步 effect —— 改错故障：模式切换读到上一帧数据，用户最后几次输入丢失。
// INV-04 断言：模式切换 effect 的依赖数组不含 form 与 jsonDraft —— 守住它的位置：切换 effect 的依赖列表 —— 改错故障：每次击键都触发序列化与反序列化，输入被重置。
// INV-05 断言：进入 json 模式只做表单到 JSON 的序列化 —— 守住它的位置：editorMode 为 json 的分支 —— 改错故障：进入时反向解析覆盖用户已填好的表单。
// INV-06 断言：退出 json 模式解析失败必须回滚 editorMode —— 守住它的位置：切换 effect 的 catch 分支 —— 改错故障：停留在无法解析的视图，界面显示与真实数据不一致。
// INV-07 断言：失败路径上不得刷新 previousEditorModeRef —— 守住它的位置：切换 effect 的 catch 分支 —— 改错故障：回滚后的重跑被误判为无切换，草稿丢失或来回震荡。
// INV-08 断言：json 模式保存前必须先解析草案 —— 守住它的位置：handleSaveClick 的 json 分支 —— 改错故障：把未解析文本或旧表单交给上层，保存内容与界面不符。
// INV-09 断言：json 解析失败时不得调用 onSave —— 守住它的位置：handleSaveClick 的 catch 分支 —— 改错故障：错误提示与提交同时发生，用户失去修正机会。
// INV-10 断言：canSave 只做只读推导，不产生副作用 —— 守住它的位置：canSave 立即执行函数 —— 改错故障：渲染期写状态，触发无限重渲染。
// INV-11 断言：必填判定必须按传输类型区分 —— 守住它的位置：canSave 的 stdio 分支 —— 改错故障：远程形态被要求填 command，保存按钮永久禁用。
// INV-12 断言：json 模式的可用性判定与保存共用同一解析函数 —— 守住它的位置：canSave 中的解析调用 —— 改错故障：按钮可点但保存即报错。
// INV-13 断言：哨兵值 auto 只存在于 UI 层，写回表单前折叠为空串 —— 守住它的位置：updateProtocolVersion —— 改错故障：空串传入 Radix Select 抛错，或配置落出非法协议版本。
// INV-14 断言：协议版本的 value 是配置与 wire 值，不随显示文案变化 —— 守住它的位置：协议版本 SelectItem 的 value —— 改错故障：客户端协商到不存在的版本，连接直接失败。
// INV-15 断言：sse 形态不渲染协议版本选择 —— 守住它的位置：传输类型不等于 sse 的条件渲染 —— 改错故障：暴露对已废弃传输无效的控件，用户误以为配置生效。
// INV-16 断言：env 与 headers 共用一段文本但按类型分流写入 —— 守住它的位置：envValue 与 updateEnvValue —— 改错故障：切换传输后写到错误字段，凭据静默丢失。
// INV-17 断言：作用域在编辑已有服务器时不可修改 —— 守住它的位置：McpScopeMenu 的 disabled 传参 —— 改错故障：改动已存在条目的作用域，产生同名重复配置。
// INV-18 断言：选择作用域必须同时更新表单级别与父级 scopeKey —— 守住它的位置：scopeSelect 的 onChange —— 改错故障：表单声明级别与实际写入目标不一致，配置落到错误文件。
//
// 状态所有权：form 与 jsonDraft 是唯一草稿事实，ref 仅作为 effect 的读取快照。
// 交互约定：保存按钮可用性由 canSave 只读推导，点击保存时才向上层提交。
// 可访问性：标签是纯文本子组件，输入控件靠 DOM 顺序关联，不注入额外 id。
import { useEffect, useRef, useState } from "react";
import type { McpSource, ZCodeMcpServer } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { ChevronDown, ChevronUpIcon as ChevronUp, Trash2 } from "lucide-react";
import {
  EMPTY_FORM,
  formToJsonDraft,
  jsonDraftToForm,
  serverToForm,
  type FormState,
  type McpEditorMode,
} from "./mcpSettingsShared.js";

// [契约] children 类型限定为 string：放开为 ReactNode 后标签内可挂交互元素，点击文字会触发错误控件聚焦。
// 样式类名是全局视觉契约，改变字号或颜色需同步 DESIGN 中的表单字段规范。
function McpFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

// [契约] McpScopeMenu 纯受控：selected、scopeKey、workspaceTabs 与 onChange 全由调用方传入，内部不存副本。
// disabled 由调用方按是否为编辑态传入，本组件不自行判断能否修改作用域。
// 标签文案每次渲染重新格式化，语言切换后无需父级重建即可更新。
function McpScopeMenu({
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
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
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

// [契约] 组件受控于父级：editingId、editorMode、scopeKey 均为入参，内部不持有权威副本。
// [契约] onSave 携带 initial 作为编辑前快照，上层据此区分新增与覆盖同名条目。
// [权衡] 初始值只在挂载时取一次快照，同实例内切换编辑对象需上层重建组件，否则表单保留旧值。
export function McpServerForm({
  initial,
  editingId,
  editorMode,
  onEditorModeChange,
  onSave,
  onCancel,
  onDelete,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: ZCodeMcpServer;
  editingId?: string;
  editorMode: McpEditorMode;
  source?: McpSource;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
  onEditorModeChange: (mode: McpEditorMode) => void;
  onSave: (form: FormState, prevServer?: ZCodeMcpServer) => void;
  onCancel: () => void;
  onDelete?: (server: ZCodeMcpServer) => void;
}) {
  // 所有用户可见文案走 intl，错误信息也用它兜底，避免出现硬编码英文。
  // 该调用必须位于组件顶层，放进条件分支会破坏 hook 顺序。
  // 与 McpScopeMenu 中的同名调用互不共享状态，各自读取当前 Provider。
  const { intl } = useZCodeIntl();
  // [契约] initialForm 每个渲染都会重算，但只被下面两个状态初始化器消费，不参与后续派生。
  // 新增条目时存储级别由 scopeKey 推导：仅 user 落到用户级，其余一律折叠为 workspace。
  // 编辑已有条目走 serverToForm，保留其原始存储级别与协议字段，不做作用域重写。
  // [失败路径] 若改成受控派生值并同步回 form，会覆盖用户正在编辑但尚未保存的内容。
  const initialForm: FormState = initial
    ? serverToForm(initial)
    : {
        ...EMPTY_FORM,
        storageLevel: scopeKey === "user" ? "user" : "workspace",
      };
  // form 是唯一草稿事实：所有输入经 update 合并到这里，再由渲染投影到各控件。
  // 不在父级保留第二份可写副本，否则两份状态会各自演化并互相覆盖。
  const [form, setForm] = useState<FormState>(initialForm);
  // JSON 草案与表单同源初始化，保证两种模式首次看到的内容一致。
  // [契约] 只有进入 json 模式时才用当前表单重新序列化覆盖，其余时刻由用户输入独占。
  const [jsonDraft, setJsonDraft] = useState<string>(() => formToJsonDraft(initialForm));
  // [失败路径] 仅解析失败时非空，任何成功解析或用户再次输入都会清空。
  // 错误信息原样展示，不吞掉底层异常 message，便于用户定位语法问题。
  const [jsonError, setJsonError] = useState<string | null>(null);
  // env 与 headers 折叠区默认收起，避免可选配置挤占主表单的视觉空间。
  // 展开状态与表单值解耦，切换传输类型时保持用户当前的展开选择。
  const [showEnv, setShowEnv] = useState(false);
  // [并发] formRef 是 form 的读快照，供模式切换 effect 读取最新值而不进入依赖数组。
  // 若把 form 直接放进切换 effect 的依赖，每次击键都会重跑切换逻辑并覆盖草稿。
  // [权衡] 因此必须由独立 effect 保持同步；漏掉同步会让切换读到上一帧数据。
  // 写入顺序由 effect 声明顺序保证：快照同步先于模式切换执行。
  const formRef = useRef(form);
  // 同理镜像 JSON 草案，供退出 json 模式时解析到最新文本。
  // 不在 setJsonDraft 的调用处顺手写 ref，避免在渲染期产生写副作用。
  const jsonDraftRef = useRef(jsonDraft);
  // 记录上一次生效的编辑器模式，用于识别真实切换并作为解析失败的返回目标。
  // [契约] 只在切换成功后更新；失败时保持旧值，下一轮才能识别为尚未切换。
  // 不能用状态替代：更新它不应触发渲染。
  const previousEditorModeRef = useRef(editorMode);

  // 提交后同步快照，保证后续 effect 与本轮渲染的表单值对齐。
  // 依赖只有 form，写 ref 不会触发额外渲染。
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  // 同上，保持 JSON 草案快照最新。
  // [失败路径] 删除该同步会让退出 json 模式解析到最后一次成功渲染的旧文本。
  useEffect(() => {
    jsonDraftRef.current = jsonDraft;
  }, [jsonDraft]);

  // [事务] 模式切换是整体动作：进入 json 做序列化，退出 json 先解析、成功才提交表单。
  // 两个方向都在成功后刷新模式快照，保证下一次比较基准正确。
  // [契约] 进入 json 的分支必须提前返回，否则会继续执行解析分支把表单反向覆盖。
  // [权衡] 依赖数组刻意不含表单与草案，通过 ref 取最新值，避免击键触发切换。
  // intl 与 onEditorModeChange 保留在依赖中：错误文案与回滚回调都可能随父级变化。
  useEffect(() => {
    const previousMode = previousEditorModeRef.current;
    // 仅在模式真正变化时执行；首次挂载与错误回滚后的重跑都从这里提前返回。
    // [契约] 该判断依赖快照而非入参对比，故失败路径上绝不能提前刷新快照。
    if (previousMode === editorMode) {
      return;
    }

    // 进入 json 模式：用当前表单重建草案，丢弃上一次残留的 JSON 文本。
    // 同时清空错误，避免旧的解析失败提示污染新视图。
    // [契约] 这里不解析草案，数据方向是单向的表单到 JSON。
    if (editorMode === "json") {
      setJsonDraft(formToJsonDraft(formRef.current));
      setJsonError(null);
      previousEditorModeRef.current = editorMode;
      return;
    }

    try {
      const parsedForm = jsonDraftToForm(jsonDraftRef.current, formRef.current);
      setForm(parsedForm);
      setJsonError(null);
      previousEditorModeRef.current = editorMode;
    // [失败路径] 退出 json 模式时草案非法：保留错误提示并请求父级把模式切回原模式。
    // 回滚目标是上一次模式而非硬编码 json，保证从任意模式进入后都能原路返回。
    // [契约] 此处不能更新模式快照，否则回滚后的重跑会被误判为无切换。
    } catch (error) {
      setJsonError(
        error instanceof Error
          ? error.message
          : intl.formatMessage({ id: "settings.mcp.form.jsonParseError" }),
      );
      onEditorModeChange(previousMode);
    }
  }, [editorMode, intl, onEditorModeChange]);

  // 唯一写入口：所有字段变更都走浅合并，便于统一处理 json 模式下的草案同步。
  // [契约] 用函数式更新基于上一次状态合并，连续快速输入不会互相覆盖。
  // 若改为直接展开当前闭包里的表单，同一渲染周期内多次调用只保留最后一次。
  function update(patch: Partial<FormState>) {
    // json 模式下把合并结果同步序列化回草案，保持两个视图内容一致。
    // [权衡] 在状态更新函数内触发另一个状态写入：严格模式下可能执行两次，但结果幂等。
    // 不用 effect 跟随表单值，否则用户手改 JSON 后会被表单值反向覆盖。
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (editorMode === "json") {
        setJsonDraft(formToJsonDraft(next));
      }
      return next;
    });
  }

  // 保存入口：json 模式先解析再提交，表单模式直接提交当前草稿。
  // [契约] initial 一并透传，作为覆盖前快照，上层据此做重名裁决与作用域写入。
  // 本函数不负责关闭弹窗，关闭与列表刷新由 onSave 的调用方决定。
  function handleSaveClick() {
    if (editorMode === "json") {
      try {
        // [事务] 解析结果先写回表单再保存，保证界面与落库内容来自同一份数据。
        // 传入当前表单作为缺省基底：草案只写部分字段时，其余字段沿用表单现有值。
        const parsedForm = jsonDraftToForm(jsonDraft, form);
        setForm(parsedForm);
        setJsonError(null);

        // [契约] json 模式保存的是解析后的表单，不是原始文本，避免上层重复解析。
        // 放在表单回写之后调用：即使父级同步卸载本组件，也已提交完整数据。
        // initial 为空表示新增，上层据此决定存储级别的最终落点。
        onSave(parsedForm, initial);
      // [失败路径] 解析失败只提示，不回滚也不保存，弹窗保持打开供用户修正。
      // 与模式切换回滚不同：这里不需要改编辑器模式，用户仍停留在 json 视图。
      } catch (error) {
        setJsonError(
          error instanceof Error
            ? error.message
            : intl.formatMessage({ id: "settings.mcp.form.jsonParseError" }),
        );
      }
      return;
    }

    // editorMode 非 json 时直接 onSave，必填校验由 canSave 驱动的禁用态先挡住。
    // [契约] 不再调用解析函数，env 与 headers 文本仍以原始字符串交给上层解释。
    onSave(form, initial);
  }

  // [契约] 只读推导按钮禁用态：每次渲染即时计算，不用 memo，避免依赖漏项导致按钮状态滞后。
  // 非 json 模式要求名称与传输必填项均非空；json 模式要求草案可解析且解析结果同样非空。
  // [权衡] 与保存流程存在一次重复解析，换来渲染期无副作用地校验草案。
  const canSave = (() => {
    if (editorMode !== "json") {
      return Boolean(
        form.name.trim() && (form.type === "stdio" ? form.command.trim() : form.url.trim()),
      );
    }
    // jsonDraft.trim() 为空时直接 return false，省去一次无意义解析。
    // [失败路径] 只有空白字符同样视为未填写。
    if (!jsonDraft.trim()) return false;
    try {
      const parsedForm = jsonDraftToForm(jsonDraft, form);
      return Boolean(
        parsedForm.name.trim() &&
        (parsedForm.type === "stdio" ? parsedForm.command.trim() : parsedForm.url.trim()),
      );
    // [失败路径] 草案语法错误时按钮禁用，错误详情留给切换或点击保存时展示。
    // 这里刻意不写错误状态：渲染期不应产生可见副作用。
    } catch {
      return false;
    }
  })();

  const envToggleLabel =
    form.type === "stdio"
      ? intl.formatMessage({ id: "settings.mcp.form.envOptional" })
      : intl.formatMessage({ id: "settings.mcp.form.headersOptional" });
  // [契约] 两种传输共用同一段文本区域，但读写字段不同：stdio 用 env，远程用 headers。
  // 切换传输类型时另一字段保持原值，便于用户来回切换而不丢配置。
  // 若只绑定其中一个字段，切换类型后界面会显示空文本而实际配置仍在。
  const envValue = form.type === "stdio" ? form.env : form.headers;
  // envPlaceholder 按 form.type 二分：stdio 给 env 键值对示例，远程给 Authorization 头示例。
  // 占位符只是格式示意，不参与校验，也不会写入表单。
  const envPlaceholder =
    form.type === "stdio"
      ? '{\n  "MY_API_KEY": "your-key"\n}'
      : '{\n  "Authorization": "Bearer your-token"\n}';
  // 按当前传输类型决定写入 env 还是 headers，两个字段互不覆盖。
  // [契约] 写入的是原始文本，结构合法性统一在解析边界校验。
  // 不要在每次击键时解析 JSON：半成品文本必然非法，会让输入无法继续。
  const updateEnvValue = (value: string) =>
    update(form.type === "stdio" ? { env: value } : { headers: value });
  // Radix Select 不接受空串 value；用 "auto" 作为哨兵值：表单里空串 = 未设置 = auto
  // （配置文件不落多余字段），用户显式选 auto 时同样写回空串。
  // [契约] 哨兵值 auto 只存在于 UI 层，写回表单前必须折叠为空串。
  // 表单空串代表未设置，序列化时省略该字段，配置文件不落多余项。
  // [失败路径] 直接把 auto 写进表单会让配置出现非法协议版本，连接协商失败。
  const updateProtocolVersion = (value: string) =>
    update({ protocolVersion: value === "auto" ? "" : value });
  // 作用域选择器在编辑已有条目时禁用：作用域决定配置文件位置，创建后不可迁移。
  // [契约] 选择结果同时更新表单存储级别与父级 scopeKey，两者必须同步。
  // 非 user 的取值统一折叠为 workspace，避免出现未知作用域字符串。
  // [失败路径] 只更新其中一处会让表单声明的级别与实际写入目标不一致。
  const scopeSelect = (
    <McpScopeMenu
      disabled={!!initial}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={(nextScopeKey) => {
        update({
          storageLevel: nextScopeKey === "user" ? "user" : "workspace",
        });
        onScopeKeyChange(nextScopeKey);
      }}
    />
  );

  return (
    <div className="space-y-4 rounded-xl border border-border p-4">
      {editorMode === "json" ? (
        <div className="space-y-3">
          <div className="flex justify-end">{scopeSelect}</div>
          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.fullConfig" })}
            </McpFormFieldLabel>
            <SettingsFormTextarea
              rows={16}
              className="font-mono text-ui-base"
              placeholder={
                '{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}'
              }
              value={jsonDraft}
              onChange={(e) => {
                setJsonDraft(e.target.value);
                if (jsonError) {
                  setJsonError(null);
                }
              }}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintPrefix" })}{" "}
              <code>{`{"server-name": {...}}`}</code>{" "}
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintMiddle" })}{" "}
              <code>{`{"mcpServers": {"server-name": {...}}}`}</code>
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintSuffix" })}
            </p>
            {jsonError && <p className="text-ui-base text-destructive">{jsonError}</p>}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="w-full min-w-0 space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.name" })}
              </McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="my-mcp-server"
                value={form.name}
                disabled={!!editingId}
                onChange={(e) => update({ name: e.target.value })}
              />
            </div>
            <div>{scopeSelect}</div>
          </div>

          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.type" })}
            </McpFormFieldLabel>
            <Select
              value={form.type}
              onValueChange={(v) => update({ type: v as FormState["type"] })}
            >
              <SelectTrigger size="lg" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">
                  {intl.formatMessage({ id: "settings.mcp.form.type.stdio" })}
                </SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
                {/*
                  Streamable HTTP 传输类型未启用。
                  <SelectItem value="streamableHttp">Streamable HTTP</SelectItem>
                */}
                <SelectItem value="sse">
                  {intl.formatMessage({ id: "settings.mcp.form.type.sse" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-full space-y-1.5 md:w-48">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.timeoutMs" })}
            </McpFormFieldLabel>
            <Input
              size="lg"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="30000"
              value={form.timeoutMs}
              onChange={(e) => update({ timeoutMs: e.target.value })}
            />
          </div>

          {/*
            sse 形态不渲染该字段：deprecated SSE transport 固定走 legacy 协商，
            该配置对其无效。
          */}
          {form.type !== "sse" && (
            <div className="w-full space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.protocolVersion" })}
              </McpFormFieldLabel>
              <Select value={form.protocolVersion || "auto"} onValueChange={updateProtocolVersion}>
                <SelectTrigger size="lg" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.auto" })}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.legacy" })}
                  </SelectItem>
                  {/* 显示名用「v2」，但 value 必须保持协议正式版本号 " "（config/wire 值，不可随文案变）*/}
                  <SelectItem value="2026-07-28">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.modern" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {form.type === "stdio" ? (
            <>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.command" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="npx"
                  value={form.command}
                  onChange={(e) => update({ command: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.args" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="-y @modelcontextprotocol/server-memory"
                  value={form.args}
                  onChange={(e) => update({ args: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <McpFormFieldLabel>URL</McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
                onChange={(e) => update({ url: e.target.value })}
              />
            </div>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-ui-base text-foreground-subtle hover:text-foreground"
              onClick={() => setShowEnv((v) => !v)}
            >
              {showEnv ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {envToggleLabel}
            </button>
            {showEnv && (
              <div className="mt-2 space-y-1.5">
                <SettingsFormTextarea
                  rows={4}
                  className="font-mono text-ui-base"
                  placeholder={envPlaceholder}
                  value={envValue}
                  onChange={(e) => updateEnvValue(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button size="lg" disabled={!canSave} onClick={handleSaveClick}>
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </div>
  );
}
