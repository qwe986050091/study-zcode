// B208 四个文件的注释 spec 生成器（target: 31/30/30/30）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/shared/src/zcode-api-retry-status.ts',
    target: 31,
    header: [
      '// INV-01 null 表示明确无重试：守住位置 首个 if 的值判等；改错故障 已恢复会话被重新标成重试。',
      '// INV-02 空对象表示无从判断：守住位置 Object.keys(record).length；改错故障 缺字段的上报被当成有重试。',
      '// INV-03 attempt 可由 nextAttempt 反推：守住位置 两个 positiveIntegerValue 的 ?? 链；改错故障 上游只给下次序号时展示成 1/1。',
      '// INV-04 attempt 下限为 1：守住位置 Math.max(..., 1)；改错故障 出现 0 次重试的非法文案。',
      '// INV-05 maxRetries 不得小于 attempt：守住位置 外层 Math.max；改错故障 展示 3/2 这类自相矛盾进度。',
      '// INV-06 maxAttempts 是总次数而非重试数：守住位置 减一运算；改错故障 上限整体多一。',
      '// INV-07 延迟缺省为 0 而不是 undefined：守住位置 retryDelayMs 的 ?? 0；改错故障 下游计时器收到 NaN。',
      '// INV-08 错误状态码缺省为 null：守住位置 errorStatus 的 ?? null；改错故障 0 被当成有效 HTTP 状态。',
      '// INV-09 错误文案有多级回退：守住位置 error 的 ?? 链；改错故障 空提示让用户不知道在重试什么。',
      '// INV-10 默认文案只在全缺失时使用：守住位置 末尾字符串常量；改错故障 上游文案被覆盖。',
      '// INV-11 stream recovery 优先于普通 attempt 判断：守住位置 model_request_started 分支；改错故障 每次新请求都把重试计数清零。',
      '// INV-12 request_started 且 attempt 不大于 1 才清空：守住位置 提前 return null；改错故障 重试中的状态被误清。',
      '// INV-13 未识别事件返回 undefined 而非 null：守住位置 末尾 return；改错故障 投影层把未知事件当成已恢复。',
      '// INV-14 恢复进展只认有内容的增量：守住位置 Boolean 包裹的取值；改错故障 空增量就清掉重试提示。',
      '//',
      '// 模块职责：把模型网络状态与 stream recovery 载荷归一成可展示的 API 重试状态。',
      '// 阅读顺序：先看 normalize 的字段回退，再看事件分派，最后看恢复进展判定与 stream recovery 提取。',
    ],
    blocks: [
      {
        anchor: 'const record = asRecord(value);',
        nth: 1,
        lines: [
          '非对象一律折成空对象，后续字段读取不需要再判空。',
        ],
      },
      {
        anchor: 'const attempt =',
        lines: [
          '优先取 attempt，缺失时从 nextAttempt 反推，两者都没有则按 2-1 兜底。',
        ],
      },
      {
        anchor: 'const maxRetries = Math.max(',
        lines: [
          '外层再与 attempt 取大，保证进度不会出现已完成大于总数。',
        ],
      },
      {
        anchor: 'kind: "api_retry",',
        nth: 1,
        lines: [
          'kind 固定，调用方据此区分重试态与普通错误。',
        ],
      },
      {
        anchor: 'export function zcodeApiRetryFromModelNetworkStatusPayload(',
        lines: [
          '事件类型决定返回态：null 是已恢复，undefined 是无信息。',
          '先看 stream recovery，再退回普通 attempt 判断。',
        ],
      },
      {
        anchor: 'if (type === "model_request_completed") {',
        lines: [
          '完成事件是确定的恢复信号。',
        ],
      },
      {
        anchor: 'if (type === "model_request_failed" && payload.retryable !== true) {',
        lines: [
          '不可重试的失败同样说明重试链已结束。',
        ],
      },
      {
        anchor: 'export function isZCodeModelRetryRecoveryProgressPayload(',
        lines: [
          '只有带内容的文本或推理增量才算有效进展。',
          '工具调用必须有 id，否则无法证明是新一轮输出。',
        ],
      },
      {
        anchor: 'export function zcodeApiRetryFromStreamRecoveryPayload(',
        lines: [
          'retryNumber 缺失即视为不是 stream recovery 载荷。',
          'maxRetries 缺省等于当前次数，展示为 n/n。',
        ],
      },
      {
        anchor: 'function asRecord(value: unknown): Record<string, unknown> {',
        lines: [
          '数组也是 object，必须显式排除，否则下标会被当成字段。',
        ],
      },
      {
        anchor: 'return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;',
        lines: [
          '正整数校验额外要求大于 0，0 视为缺失。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/app-shell/PlanDetailSidePane.tsx',
    target: 30,
    header: [
      '// INV-01 租约必须释放：守住位置 useEffect 的 cleanup；改错故障 关闭侧栏后会话引用计数泄漏。',
      '// INV-02 租约随父会话切换重建：守住位置 依赖数组 layer 与 parentSessionId；改错故障 切会话后仍读旧投影。',
      '// INV-03 投影只在有租约时订阅：守住位置 useConversationProjection(lease)；改错故障 空租约导致重复订阅。',
      '// INV-04 实时内容只认 toolCall 行：守住位置 kind 双重判断；改错故障 同 id 的其它行被误解析成计划。',
      '// INV-05 窗口外不阻塞渲染：守住位置 find 的返回值判空；改错故障 消息被裁出窗口时侧栏白屏。',
      '// INV-06 摘要是两路选择的兜底：守住位置 liveMarkdown ?? lastMarkdown；改错故障 流式中断后内容回退为空。',
      '// INV-07 tab.markdown 变化要覆盖缓存：守住位置 第二个 useEffect；改错故障 打开历史计划仍显示上一条。',
      '// INV-08 实时内容优先于快照：守住位置 合并顺序；改错故障 用户看到滞后的计划文本。',
      '// INV-09 主题与预览设置走默认值订阅：守住位置 useZCodeStoreWithDefault；改错故障 未初始化时渲染报错。',
      '// INV-10 scope 只在字段存在时展开：守住位置 条件展开三元；改错故障 undefined 身份被当成有效 scope。',
      '// INV-11 scope 依赖必须精确：守住位置 useMemo 依赖数组；改错故障 切换工作区后连接不重建。',
      '// INV-12 provider 只按 scope 路由：守住位置 V4PaneConversationProvider；改错故障 侧栏误用 shell 身份分支。',
      '// INV-13 容器承担滚动而非外层：守住位置 overflow-y-auto 与 min-h-0；改错故障 长计划把布局撑破。',
      '// INV-14 组件用 memo 隔离：守住位置 两处 memo；改错故障 父级高频重渲染带动整篇 markdown 重排。',
      '//',
      '// 模块职责：在侧栏中挂载单条计划工具调用的实时与历史内容，并保证会话租约生命周期正确。',
      '// 阅读顺序：先看 PlanDetailContent 的租约与内容合并，再看 PlanDetailSidePane 的 scope 构造与注入。',
    ],
    blocks: [
      {
        anchor: 'const [lastMarkdown, setLastMarkdown] = useState(tab.markdown);',
        lines: [
          '初值取打开时的快照，实时内容到达前先显示它。',
        ],
      },
      {
        anchor: 'const codePreviewSettings = useZCodeStoreWithDefault(',
        lines: [
          '预览设置与主题都从 store 取默认值，未初始化也能渲染。',
        ],
      },
      {
        anchor: 'const nextLease = layer.acquire(tab.parentSessionId);',
        lines: [
          '进入即占租约，退出必须由 cleanup 释放。',
        ],
      },
      {
        anchor: 'const liveMarkdown = useMemo(() => {',
        lines: [
          '只在当前窗口里找目标行，避免遍历全量历史。',
        ],
      },
      {
        anchor: 'if (!row || row.kind !== "toolCall") return undefined;',
        lines: [
          '找不到或类型不符一律返回 undefined，交给缓存兜底。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        nth: 2,
        lines: [
          '实时内容一旦有效就写入缓存，供后续切换回退。',
        ],
      },
      {
        anchor: 'if (tab.markdown) setLastMarkdown(tab.markdown);',
        lines: [
          '快照更新时以快照为准，避免停留在旧计划。',
        ],
      },
      {
        anchor: 'const markdown = liveMarkdown ?? lastMarkdown;',
        lines: [
          '合并顺序固定：实时优先，其次缓存，最后空串。',
        ],
      },
      {
        anchor: 'data-plan-detail-tool-call-id={tab.toolCallId}',
        lines: [
          'DOM 上标注来源，便于自动化测试定位具体计划。',
        ],
      },
      {
        anchor: 'const scope = useMemo<PaneWorkspaceScope>(',
        lines: [
          'scope 只带存在字段，未设置的身份不落成 undefined。',
        ],
      },
      {
        anchor: '...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),',
        lines: [
          '条件展开而非置空，保持对象形状稳定。',
        ],
      },
      {
        anchor: '<V4PaneConversationProvider scope={scope}>',
        lines: [
          '连接路由完全由 scope 决定，侧栏不再区分 shell 身份。',
        ],
      },
      {
        anchor: '<PlanDetailContent',
        lines: [
          '内容组件拿到与 provider 同一份 tab 与回调。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/chat-input-toolbar/CodingPlanUsageHeaderAction.tsx',
    target: 30,
    header: [
      '// INV-01 loading 期间只显示刷新态：守住位置 第一个早退分支；改错故障 刷新时同时出现成功勾与转圈。',
      '// INV-02 只把 true 到 false 视为一次刷新结束：守住位置 wasLoading === true；改错故障 首次挂载就闪一下成功。',
      '// INV-03 有错误则不给成功反馈：守住位置 !error 条件；改错故障 刷新失败仍显示勾。',
      '// INV-04 成功态自动回落：守住位置 1000ms 定时器；改错故障 勾一直挂着，看不出后续刷新。',
      '// INV-05 定时器必须清理：守住位置 return 的 clearTimeout；改错故障 卸载后仍写状态。',
      '// INV-06 每次 loading 变化都同步 ref：守住位置 ref 赋值早于判断；改错故障 下一次比较用的是陈旧值。',
      '// INV-07 loading 开始时重置为 idle：守住位置 setRefreshActionState 的 idle 分支；改错故障 上一轮的成功勾延续到新一轮。',
      '// INV-08 无点击回调就不渲染按钮：守住位置 onUsageClick 条件；改错故障 出现点了没反应的入口。',
      '// INV-09 点击必须阻断冒泡与默认行为：守住位置 preventDefault 与 stopPropagation；改错故障 触发外层菜单或表单提交。',
      '// INV-10 警告图标独立于按钮：守住位置 warningLabel 条件；改错故障 无入口时警告也被隐藏。',
      '// INV-11 三个状态都带角色：守住位置 两处 status 与一处 img；改错故障 读屏软件读不到刷新结果。',
      '// INV-12 动画尊重减少动态偏好：守住位置 motion-reduce 变体；改错故障 前庭敏感用户仍看到旋转。',
      '// INV-13 文案全部由 props 注入：守住位置 组件内无硬编码文案；改错故障 多语言环境出现混排。',
      '// INV-14 常量集中定义：守住位置 CONTEXT_USAGE_REFRESH_SUCCESS_MS；改错故障 各处时长不一致。',
      '//',
      '// 模块职责：套餐用量入口按钮的加载、成功与警告三态渲染。',
      '// 阅读顺序：先看刷新状态机，再看三个早退渲染分支，最后看警告与入口的组装。',
    ],
    blocks: [
      {
        anchor: 'const [refreshActionState, setRefreshActionState] = useState<"idle" | "success">("idle");',
        lines: [
          '只有 idle 与 success 两态，加载态由 props 决定。',
        ],
      },
      {
        anchor: 'const previousLoadingRef = useRef<boolean | null>(null);',
        lines: [
          '记录上一次的 loading，用于识别真正的下降沿。',
        ],
      },
      {
        anchor: 'const wasLoading = previousLoadingRef.current;',
        lines: [
          '先取值再写入，否则下降沿永远检测不到。',
        ],
      },
      {
        anchor: 'if (wasLoading === true && !error) {',
        lines: [
          '只有从加载中落到无错，才算刷新成功。',
        ],
      },
      {
        anchor: '() => setRefreshActionState("idle"),',
        lines: [
          '成功态只保留一秒，随后自动回到可点击形态。',
        ],
      },
      {
        anchor: 'if (loading) {',
        nth: 2,
        lines: [
          '加载中优先于其它状态，成功勾不会与转圈并存。',
        ],
      },
      {
        anchor: 'if (refreshActionState === "success") {',
        lines: [
          '成功态同样只占图标位，避免按钮宽度跳动。',
        ],
      },
      {
        anchor: '{warningLabel ? (',
        lines: [
          '警告与入口可同时存在，两者顺序固定。',
        ],
      },
      {
        anchor: '{onUsageClick ? (',
        lines: [
          '没有点击行为就不渲染入口，避免死按钮。',
        ],
      },
      {
        anchor: 'onClick={(event) => {',
        lines: [
          '阻断冒泡，防止同时触发外层菜单的关闭逻辑。',
        ],
      },
      {
        anchor: '<span>{openLabel}</span>',
        lines: [
          '入口文案由调用方按语言注入。',
        ],
      },
      {
        anchor: '<ChevronRightIcon className="size-3.5" />',
        lines: [
          '箭头暗示会打开独立面板而非就地展开。',
        ],
      },
      {
        anchor: 'const CONTEXT_USAGE_REFRESH_SUCCESS_MS = 1_000;',
        lines: [
          '成功提示的停留时长集中在此，便于统一调整。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/components/ai-elements/conversation.tsx',
    target: 30,
    header: [
      '// INV-01 组件族全部薄封装滚动库：守住位置 四个导出组件的 JSX；改错故障 自研滚动会让吸底行为偏离上游。',
      '// INV-02 初始与 resize 都立即滚动：守住位置 initial 与 resize 两个 instant；改错故障 切任务时出现缓动追底。',
      '// INV-03 立即滚动是为避免恢复历史叠两层动画：守住位置 该处属性取值；改错故障 体感卡顿回归。',
      '// INV-04 消息区占满剩余高度：守住位置 flex-1 与 overflow-y-hidden；改错故障 长对话把输入框挤出视口。',
      '// INV-05 停止按需隐藏：守住位置 非底部条件；改错故障 已在底部时仍显示回到底部按钮。',
      '// INV-06 回底同样用立即滚动：守住位置 scrollToBottom 的 instant 参数；改错故障 与 INV-02 不一致。',
      '// INV-07 空态允许完全覆盖：守住位置 children 的空值合并；改错故障 自定义空态与默认文案同时出现。',
      '// INV-08 下载内容按 parts 拼文本：守住位置 文本类型过滤；改错故障 工具调用片段混进导出文本。',
      '// INV-09 导出格式可由调用方替换：守住位置 formatMessage 默认参数；改错故障 无法定制为其它格式。',
      '// INV-10 默认格式带角色前缀：守住位置 roleLabel 拼接；改错故障 导出内容分不清谁说的。',
      '// INV-11 URL 必须回收：守住位置 revokeObjectURL；改错故障 每次下载泄漏一个 blob。',
      '// INV-12 临时链接用完即移除：守住位置 link.remove()；改错故障 DOM 残留增加。',
      '// INV-13 深层导入带 .js 后缀：守住位置 相对导入；改错故障 NodeNext 下解析失败。',
      '// INV-14 文件头保留上游许可：守住位置 首段块注释；改错故障 违反 Apache-2.0 归属要求。',
      '//',
      '// 模块职责：会话消息区的滚动容器、空态、回到底部与导出按钮。',
      '// 阅读顺序：先看 Conversation 的滚动策略，再看空态与回底按钮，最后看导出与 markdown 拼装。',
    ],
    blocks: [
      {
        anchor: '<StickToBottom',
        lines: [
          '滚动容器由上游库负责，本组件只改默认参数。',
        ],
      },
      {
        anchor: 'role="log"',
        lines: [
          '语义上标成日志区，读屏可播报新消息。',
        ],
      },
      {
        anchor: 'export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (',
        lines: [
          '内容层不参与滚动策略，只负责宽度与内边距。',
        ],
      },
      {
        anchor: 'export const ConversationEmptyState = ({',
        lines: [
          '空态文案有默认值，调用方可整体替换。',
        ],
      },
      {
        anchor: '{children ?? (',
        lines: [
          '传了 children 就完全不渲染默认结构。',
        ],
      },
      {
        anchor: 'const { isAtBottom, scrollToBottom } = useStickToBottomContext();',
        lines: [
          '只有处于非底部时才需要回底入口。',
        ],
      },
      {
        anchor: 'const handleScrollToBottom = useCallback(() => {',
        lines: [
          '回调保持稳定，避免按钮每次渲染重建。',
        ],
      },
      {
        anchor: 'const getMessageText = (message: UIMessage): string =>',
        lines: [
          '只取文本片段，忽略工具与推理等非正文内容。',
        ],
      },
      {
        anchor: 'const defaultFormatMessage = (message: UIMessage): string => {',
        lines: [
          '角色首字母大写，形成 markdown 粗体前缀。',
        ],
      },
      {
        anchor: 'export const messagesToMarkdown = (',
        lines: [
          '消息之间用空行分隔，符合 markdown 段落语义。',
        ],
      },
      {
        anchor: 'const blob = new Blob([markdown], { type: "text/markdown" });',
        lines: [
          'MIME 明确为 markdown，浏览器下载后可直接预览。',
        ],
      },
      {
        anchor: 'URL.revokeObjectURL(url);',
        lines: [
          '回收放在移除链接之后，保证下载已开始。',
        ],
      },
      {
        anchor: '{children ?? <DownloadIcon className="size-4" />}',
        lines: [
          '允许用自定义图标替换默认下载图标。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAnchor = srcLines[0].replace(/\r$/, '').trim();
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b208-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
