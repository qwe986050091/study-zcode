// INV-01 卡片为纯受控视图，名称草稿与启停状态只读自 props；守住位置：BotSummaryCard 参数解构；改错故障：组件内副本导致开关与名称显示滞后于服务端事实
// INV-02 宽度测量只在 renaming 为真时启用，退出编辑立即清空；守住位置：useLayoutEffect 首个分支；改错故障：残留宽度把普通按钮挤成定宽空白
// INV-03 隐藏测量节点的字号与内边距必须与输入框一致；守住位置：测量 button 的类名；改错故障：编辑框宽度与文字长度不符，出现跳动或截断
// INV-04 测量节点必须保留空白不折叠；守住位置：测量 button 的行内样式；改错故障：含首尾空格的名称宽度偏小，输入内容被遮住
// INV-05 测量结果向上取整，吞掉亚像素误差；守住位置：updateWidth 内部的取整；改错故障：输入框比文字窄一个像素，末尾字符被裁
// INV-06 尺寸观察者必须在副作用清理中断开；守住位置：useLayoutEffect 返回的清理函数；改错故障：反复重命名累积观察者，引发多余重渲染与内存增长 [资源]
// INV-07 状态文案优先级为连接错误高于已绑定高于未绑定；守住位置：summaryStatusText 三元链；改错故障：连接失败显示成未绑定，用户按提示重新绑定仍失败 [失败路径]
// INV-08 未绑定分支必须使用未绑定文案，不得复用运行时文案；守住位置：summaryStatusText 末尾分支；改错故障：未绑定机器人显示在线描述，误导诊断方向
// INV-09 绑定态只由 providerUserId 的真值决定；守住位置：isBound 计算；改错故障：以其他字段推断绑定，切换账号后状态错位
// INV-10 图标降级规则为已绑定或错误显示状态点，否则显示时钟占位；守住位置：botIdentityDescription 条件分支；改错故障：未绑定卡片误显示在线绿点，用户以为可直接使用
// INV-11 名称输入框的值必须完全来自受控 prop，不得内部另存；守住位置：重命名 input 的 value 绑定；改错故障：草稿与提交值分叉，失焦后名称回弹
// INV-12 失焦提交必须幂等，重复触发不重复写库；守住位置：input 的 onBlur 提交回调；改错故障：回弹与失焦连发产生两次更新，名称被旧值覆盖 [事务]
// INV-13 组合输入期间不提交，避免拼音中间态落库；守住位置：组合开始与结束回调透传；改错故障：拼音半成品被保存成机器人名称 [失败路径]
// INV-14 回车只作为进入重命名的入口，不在该入口提交；守住位置：名称按钮的按键处理；改错故障：回车误提交空名，名称被清空
// INV-15 观察者回调只写本地宽度，不能反向触发布局循环；守住位置：尺寸观察回调；改错故障：宽度写入再次触发观测，界面持续抖动 [并发]
// INV-16 名称展示优先级为选中显式名高于兜底名；守住位置：nameEditorText 合成；改错故障：空名称时输入框空白且无占位，用户不知当前对象
// INV-17 启停开关只向上抛补丁，不在卡片内改状态；守住位置：Switch 变更回调；改错故障：卡片与列表各持一份启用态，刷新后互相打脸 [权衡]
// INV-18 回复粒度选项必须由 provider 派生，不得硬编码；守住位置：BotReplyGranularityCard 取选项与选中项；改错故障：切换渠道后出现不支持的粒度，保存即失败
// INV-19 删除入口必须保持危险语义且文案可国际化；守住位置：BotDangerCard 按钮；改错故障：误触无视觉警示，造成不可逆的机器人配置丢失 [失败路径]
// INV-20 所有可见文案经国际化 provider 输出，禁止内联中英文；守住位置：三个组件的文案取值；改错故障：切语言后残留硬编码文案，界面中英混杂
//
// 总述：本文件只做机器人摘要、回复粒度与删除三块的展示编排，不持有服务端事实。
// 状态与草稿由父级注入，事件只向上抛补丁；卡片内仅保留测量用的像素宽度。
// 修改时优先保持受控性，再调整布局细节，避免把交互状态下沉到组件内部。
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Clock3, Trash2 } from "lucide-react";
import type {
  BotConfig,
  BotReplyGranularity,
  BotServiceStatus,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  SettingsGroupCard,
  SettingsRow,
} from "@/settings/SettingsPageParts.js";
import {
  getBotReplyGranularitiesForProvider,
  getBotReplyGranularityEntryForProvider,
} from "@/botsUi.js";
import { cn } from "@/components/lib/utils.js";
import { ProviderIcon, runtimeDot, runtimeText } from "./shared.js";

// 机器人摘要卡：左侧渠道图标、中间名称与状态、右侧启停开关，自身不请求数据
// [权衡] 名称编辑用受控输入框，隐藏测量节点只负责宽度，避免组件内复制一份草稿
export function BotSummaryCard({
  bot,
  runtime,
  selectedBotDisplayName,
  selectedBotName,
  fallbackBotName,
  renaming,
  onStartRename,
  onCommitNameDraft,
  onNameDraftChange,
  onNameCompositionEnd,
  onNameCompositionStart,
  onNameInputKeyDown,
  onPatchBot,
}: {
  // [事务] bot 是父级传入的服务端快照，卡片内任何展示都不得写入该对象
  // [失败路径] 若父级尚未刷新，展示旧名称属预期，这里不做乐观覆盖
  bot: BotConfig;
  runtime: BotServiceStatus["botRuntime"][number] | undefined;
  selectedBotDisplayName: string;
  selectedBotName: string;
  fallbackBotName: string;
  // renaming 由父级控制，卡片只据此在输入框与按钮两个分支间切换
  // [并发] 外部强制退出重命名时，副作用会清空测量宽度，无需组件额外复位
  renaming: boolean;
  onStartRename: () => void;
  onCommitNameDraft: () => void;
  onNameDraftChange: (value: string) => void;
  onNameCompositionEnd?: () => void;
  // 组合输入开始与结束回调是可选的，父级不关心输入法时可以不传
  // [失败路径] 透传空值给输入框是安全的，React 会跳过该事件绑定
  onNameCompositionStart?: () => void;
  onNameInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  const nameMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  const [nameEditorWidth, setNameEditorWidth] = useState<number | null>(null);
  // [资源] 绑定态只取 providerUserId 的真值，避免空串被当成已绑定
  // 该值同时决定状态点与文案分支，是全卡片唯一的绑定判定入口
  const isBound = Boolean(bot.providerUserId);
  // 修复原因：连接失败会直接阻断 /bind，不能再用“未绑定”覆盖真正的阻塞状态。
  // [失败路径] 连接错误优先于绑定态展示，因为错误会直接阻断重新绑定
  // 渠道专用错误文案按 provider 三分支选择，飞书与 Lark 分别提示
  // [权衡] 错误态仍显示状态圆点而非时钟，表明这是已绑定的连接问题
  const summaryStatusText =
    runtime?.status === "error"
      ? intl.formatMessage({
          id:
            bot.provider === "feishu"
              ? "bots.runtime.feishuConnectionFailed"
              : bot.provider === "lark"
                ? "bots.runtime.larkConnectionFailed"
                : "bots.runtime.connectionFailed",
        })
      : isBound
        ? runtimeText(runtime, bot.enabled, (id) => intl.formatMessage({ id }))
        : intl.formatMessage({ id: "bots.unbound" });
  // 测量文本与输入框共用同一优先级的名称，保证测量宽度与显示一致
  // 选中名称为空时回落到兜底名，测量节点也不会测量空串
  const nameEditorText = selectedBotName || fallbackBotName;

  // 用布局副作用测量，首帧绘制前即可拿到宽度，避免输入框先窄后宽
  // [并发] 依赖名称文本与 renaming，改名或重新进入编辑都会重算
  useLayoutEffect(() => {
    if (!renaming) {
      setNameEditorWidth(null);
      return undefined;
    }
    const measureButton = nameMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    // 宽度向上取整，避免亚像素被截断后输入框比文字窄
    // 每次测量都读取测量节点的最新布局，与输入框内容同步更新
    const updateWidth = () => {
      setNameEditorWidth(
        Math.ceil(measureButton.getBoundingClientRect().width),
      );
    };
    updateWidth();
    // [资源] 观察测量节点而非窗口，字体或语言变化引起的尺寸变化也能捕获
    // 回调只写本地宽度状态，不触碰父级数据，重复触发天然幂等
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    // [资源] 卸载或依赖变化时断开观察者，防止闭包持有旧节点
    // 清理与创建成对出现，重命名反复开关不会累积观察者
    return () => resizeObserver.disconnect();
  }, [nameEditorText, renaming]);

  // 名称控件统一出口，重命名与展示两种形态共用同一外层容器
  // 把分支收在一个变量里，主渲染结构保持扁平，便于对齐图标与开关
  const botNameControl = (
    <div className="min-w-0">
      {renaming ? (
        <label
          className="relative inline-block min-w-6 max-w-md align-middle"
          style={
            nameEditorWidth ? { width: `${nameEditorWidth}px` } : undefined
          }
        >
          <span className="sr-only">
            {intl.formatMessage({ id: "bots.name" })}
          </span>
          <button
            ref={nameMeasureButtonRef}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 invisible max-w-md overflow-hidden rounded-sm px-1 text-left text-ui-lg font-medium"
            // 隐藏测量节点默认会折叠首尾空格，导致输入名称带空格时宽度偏小；保留空白才能和 input 的实际内容宽度一致。
            // [失败路径] 保留空白后，名称含首尾空格时测量宽度才与输入框内容一致
            style={{ whiteSpace: "pre" }}
          >
            {nameEditorText}
          </button>
          <input
            autoFocus
            className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-lg font-medium leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
            // [事务] 输入框值完全受控于父级草稿，组件内不保留第二份文本
            value={selectedBotName}
            onBlur={onCommitNameDraft}
            onChange={(event) => onNameDraftChange(event.target.value)}
            onCompositionEnd={onNameCompositionEnd}
            onCompositionStart={onNameCompositionStart}
            // `onFocus` 触发全选：用户改名时直接覆盖原值而无需手动清空。
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={onNameInputKeyDown}
            placeholder={fallbackBotName}
          />
        </label>
      // 非编辑态退化为按钮，点击或回车才进入编辑，避免常驻输入框
      ) : (
        <button
          type="button"
          className="min-w-0 max-w-md truncate rounded-sm px-1 text-left text-ui-lg font-medium hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
          onClick={onStartRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onStartRename();
            }
          }}
        >
          {selectedBotDisplayName}
        </button>
      )}
    </div>
  );

  // 身份行由状态点与状态文案组成，图标类型即绑定与连接的可视摘要
  // 文案始终来自 summaryStatusText，图标只做视觉强化，不承载额外语义
  const botIdentityDescription = (
    <span className="inline-flex items-center gap-2 text-foreground-subtle">
      {isBound || runtime?.status === "error" ? (
        <span
          className={cn(
            "size-1.5 rounded-full",
            runtimeDot(runtime, bot.enabled),
          )}
        />
      ) : (
        <Clock3 className="size-3 text-foreground-subtle" />
      )}
      {summaryStatusText}
    </span>
  );

  return (
    // 横向三段布局：固定图标、可伸缩文本、固定开关，窄屏时只压缩中间段
    // 图标固定尺寸且禁止收缩，保证不同语言下左侧视觉基线稳定
    <div className="flex items-center gap-3 pb-2 px-2">
      <ProviderIcon
        provider={bot.provider}
        className="size-12 shrink-0 text-foreground-subtle"
      />
      <div className="min-w-0 flex-1 space-y-1">
        {botNameControl}
        {botIdentityDescription}
      </div>
      <div className="shrink-0">
        <Switch
          checked={bot.enabled}
          // [事务] 开关只上抛启用补丁，落库与回滚由父级统一处理
          // [并发] 快速连续切换会并发提交，父级需以最后写入为准或串行化
          onCheckedChange={(enabled) => onPatchBot({ enabled })}
        />
      </div>
    </div>
  );
}

// 回复粒度卡复用设置行组件，只负责选项映射与补丁上抛
// [权衡] 选中项由 provider 与 replyMode 共同派生，非法组合自动落到默认项
export function BotReplyGranularityCard({
  bot,
  onPatchBot,
}: {
  bot: BotConfig;
  onPatchBot: (patch: Partial<BotConfig>) => void;
}) {
  const { intl } = useZCodeIntl();
  // [失败路径] 选项按渠道过滤，切换渠道后不再展示该渠道不支持的粒度
  const replyGranularities = getBotReplyGranularitiesForProvider(bot.provider);
  const selectedGranularity = getBotReplyGranularityEntryForProvider(
    bot.provider,
    bot.replyMode,
  );

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "bots.replyGranularity" })}
      description={intl.formatMessage({
        id: selectedGranularity.descriptionId,
      })}
      control={
        <Select
          // [事务] 选择框值取派生后的选中项，而非原始 replyMode，避免非法值回显为空
          // 变更回调把字符串收窄为粒度类型再上抛，类型边界只在此处收敛
          value={selectedGranularity.id}
          onValueChange={(replyMode) =>
            onPatchBot({ replyMode: replyMode as BotReplyGranularity })
          }
        >
          <SelectTrigger size="lg" className="w-48 justify-between">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {replyGranularities.map((granularity) => (
              <SelectItem key={granularity.id} value={granularity.id}>
                {intl.formatMessage({ id: granularity.labelId })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

// 危险操作卡独立成组件，删除按钮保持危险变体与独立标题
// [失败路径] 组件不内置确认弹窗，二次确认由父级删除回调负责，避免双保险冲突
// [权衡] 文案与标题复用同一国际化 key，保持按钮可读且不引入新字符串
export function BotDangerCard({ onDelete }: { onDelete: () => void }) {
  const { intl } = useZCodeIntl();

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "bots.delete" })}
        description={intl.formatMessage({ id: "bots.delete.description" })}
        control={
          // [资源] 删除按钮尺寸与其他设置行动作一致，保证行高对齐
          // 按钮仅透传点击回调，不在此处做权限或可用性判断
          <Button
            variant="destructive"
            size="lg"
            onClick={onDelete}
            title={intl.formatMessage({ id: "bots.delete" })}
          >
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "bots.delete" })}
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
