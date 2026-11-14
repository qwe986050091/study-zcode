import fs from 'node:fs';

const specs = [
  {
    file: 'packages/ui/src/remote-connection-flow/ui/RemoteConnectionProgress.tsx',
    target: 40,
    header: [
      '// INV-01 进度通道只读：守住位置 ProgressContext；改错故障 消费方直接改状态。',
      '// INV-02 发布通道独立：守住位置 PublishProgressContext；改错故障 发布方订阅自身结果。',
      '// INV-03 发布命令必须稳定：守住位置 useState 返回；改错故障 每次渲染触发新订阅。',
      '// INV-04 卸载清空进度：守住位置 清理 effect；改错故障 离开页面后残留旧日志。',
      '// INV-05 阶段由日志推导：守住位置 resolveRemoteConnectionPhases；改错故障 进度与真实状态脱节。',
      '// INV-06 活动阶段优先失败态：守住位置 active 查找；改错故障 失败被进行中掩盖。',
      '// INV-07 无活动阶段取首段：守住位置 空值兜底；改错故障 标题访问空对象。',
      '// INV-08 百分比按完成段数：守住位置 percent 计算；改错故障 进度长期停在零。',
      '// INV-09 百分比取整：守住位置 取整函数；改错故障 展示长小数。',
      '// INV-10 设备名可空：守住位置 device 回退；改错故障 字符串 undefined 透出。',
      '// INV-11 目标格式化集中：守住位置 formatRemoteLinkRailTarget；改错故障 展示格式分叉。',
      '// INV-12 进行中需三重条件：守住位置 progressing；改错故障 已取消仍转圈。',
      '// INV-13 标题按优先级选择：守住位置 嵌套三元；改错故障 错误态显示连接中。',
      '// INV-14 副标题回退当前阶段：守住位置 兜底文案；改错故障 副标题为空。',
      '// INV-15 进度条带无障碍属性：守住位置 role 与 aria 值；改错故障 读屏无法感知进度。',
      '// INV-16 取消与继续分开：守住位置 两个按钮；改错故障 误触直接中断连接。',
      '// INV-17 最小化卡不发起连接：守住位置 组件职责；改错故障 渲染即触发副作用。',
      '// INV-18 文案全部国际化：守住位置 formatMessage；改错故障 中文硬编码透出。',
      '//',
      '// 模块职责：提供连接进度的发布与订阅，并渲染最小化的进度卡。',
      '// 状态所有权：进度值归 Provider；展示组件全部由 props 驱动。',
      '// 阅读顺序：先看两个上下文，再看阶段与百分比计算，最后看卡片渲染。',
    ],
    blocks: [
      {
        anchor: 'const ProgressContext = createContext<RemoteConnectionProgress | null>(null);',
        lines: [
          '进度通道只读。',
          '默认空值表示未连接。',
          '发布通道单独定义。',
        ],
      },
      {
        anchor: 'const [progress, publish] = useState<RemoteConnectionProgress | null>(null);',
        lines: [
          '发布方只拿到稳定命令。',
          '显示结果由子组件订阅。',
          '断开时发布空值。',
        ],
      },
      {
        anchor: 'const publish = useContext(PublishProgressContext);',
        lines: [
          '未包裹时静默跳过。',
          '进度变化后重新发布。',
          '卸载时清空进度。',
        ],
      },
      {
        anchor: 'const phases = resolveRemoteConnectionPhases(logs);',
        lines: [
          '阶段由日志推导。',
          '活动阶段优先取失败态。',
          '全部完成时取首段兜底。',
        ],
      },
      {
        anchor: 'const percent = Math.round(',
        lines: [
          '完成段数除以总段数。',
          '百分比四舍五入取整。',
          '仅进度态展示。',
        ],
      },
      {
        anchor: 'const title = intl.formatMessage(',
        lines: [
          '就绪优先于错误。',
          '取消优先于进行中。',
          '视图名作为最后兜底。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/settings/DataBaseDirControl.tsx',
    target: 39,
    header: [
      '// INV-01 草稿与配置分离：守住位置 localDataBaseDir；改错故障 每次输入被外部值覆盖。',
      '// INV-02 空配置回落默认目录：守住位置 effectiveDir；改错故障 输入框为空。',
      '// INV-03 浏览只改草稿：守住位置 handleBrowseDataBaseDir；改错故障 选目录即触发迁移。',
      '// INV-04 保存才执行迁移：守住位置 handleSave；改错故障 迁移与浏览混在一起。',
      '// INV-05 默认目录存为空串：守住位置 newValue；改错故障 默认值被持久化。',
      '// INV-06 保存中禁用交互：守住位置 isSaving；改错故障 重复点击并发迁移。',
      '// INV-07 浏览中禁用交互：守住位置 isPickingDataBaseDir；改错故障 重复打开弹窗。',
      '// INV-08 非脏值不可保存：守住位置 isDirty；改错故障 空提交覆盖配置。',
      '// INV-09 保存成功保留草稿：守住位置 effect 条件；改错故障 保存后立即回退旧值。',
      '// INV-10 保存失败恢复可编辑：守住位置 error 状态；改错故障 无法重试。',
      '// INV-11 错误文案按类型选择：守住位置 错误判断；改错故障 安装目录错误被报成复制失败。',
      '// INV-12 输入框只读：守住位置 readOnly；改错故障 手输任意路径。',
      '// INV-13 保存成功提示需重启：守住位置 saved 分支；改错故障 用户不知道要重启。',
      '// INV-14 状态提示带测试标识：守住位置 data-testid；改错故障 端到端无法断言状态。',
      '// INV-15 按钮文案国际化：守住位置 formatMessage；改错故障 中文硬编码透出。',
      '// INV-16 选择取消不报错：守住位置 空值早退；改错故障 取消被当成失败。',
      '// INV-17 组件不直接调用平台：守住位置 props 回调；改错故障 测试无法注入。',
      '// INV-18 依赖数组完整：守住位置 useCallback；改错故障 闭包捕获旧值。',
      '//',
      '// 模块职责：数据目录设置控件，负责草稿编辑、目录选择与保存迁移。',
      '// 状态所有权：配置归父级；草稿、忙碌与保存状态为组件局部态。',
      '// 阅读顺序：先看草稿同步，再看浏览与保存回调，最后看状态提示渲染。',
    ],
    blocks: [
      {
        anchor: 'const effectiveDir = dataBaseDir || defaultHomeDir;',
        lines: [
          '空配置回落到默认目录。',
          '有效目录驱动输入框。',
          '不改变服务端配置。',
        ],
      },
      {
        anchor: 'const [localDataBaseDir, setLocalDataBaseDir] = useState(effectiveDir);',
        lines: [
          '草稿值独立于配置。',
          '浏览只更新草稿。',
          '保存成功后才对齐配置。',
          '保留用户未保存的输入。',
        ],
      },
      {
        anchor: 'useEffect(() => {',
        lines: [
          '非保存成功时同步外部值。',
          '保存成功保留草稿。',
          '依赖有效目录与保存状态。',
        ],
      },
      {
        anchor: 'const handleBrowseDataBaseDir = useCallback(async () => {',
        lines: [
          '只接受系统弹窗返回路径。',
          '取消选择直接返回。',
          '选择后重置错误态。',
          '忙碌标记在 finally 复位。',
        ],
      },
      {
        anchor: 'const handleSave = useCallback(async () => {',
        lines: [
          '默认目录存为空串。',
          '保存中禁用交互。',
          '失败按错误类型选文案。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/store/codeCommentPreviewStore.ts',
    target: 39,
    header: [
      '// INV-01 桶键由工作区与源路径组成：守住位置 桶键构造；改错故障 不同工作区互相污染。',
      '// INV-02 空数组常量化：守住位置 模块常量；改错故障 每次渲染触发更新。',
      '// INV-03 读取缺省返回空数组：守住位置 getComments；改错故障 消费方需处理 undefined。',
      '// INV-04 添加按 id 去重：守住位置 addComment；改错故障 同一评论出现两次。',
      '// INV-05 添加保持追加顺序：守住位置 展开顺序；改错故障 最新评论跑到最前。',
      '// INV-06 删除无变化即返回原状态：守住位置 removeComment；改错故障 无谓重渲染。',
      '// INV-07 按来源删除跨桶扫描：守住位置 removeCommentBySource；改错故障 其他工作区评论被误删。',
      '// INV-08 来源删除以工作区前缀过滤：守住位置 前缀判断；改错故障 相似工作区键误匹配。',
      '// INV-09 有变化才替换状态：守住位置 changed 标志；改错故障 全量对象重建。',
      '// INV-10 恢复前先解除移除标记：守住位置 unmarkCodeCommentRemoved；改错故障 恢复的评论仍被过滤。',
      '// INV-11 恢复要求源路径存在：守住位置 早退判断；改错故障 空路径产生非法桶。',
      '// INV-12 恢复复用添加路径：守住位置 addComment 调用；改错故障 两条写入逻辑分叉。',
      '// INV-13 清空只删目标桶：守住位置 解构删除；改错故障 其他注释被清空。',
      '// INV-14 清空不存在的桶直接返回：守住位置 存在性判断；改错故障 每次清空都新建对象。',
      '// INV-15 状态不持久化：守住位置 store 职责；改错故障 预览与磁盘数据混淆。',
      '// INV-16 写入只通过 set：守住位置 实现；改错故障 外部直接改对象。',
      '// INV-17 读取只返回当前快照：守住位置 get；改错故障 调用方持有可变引用。',
      '// INV-18 评论对象整体替换：守住位置 addComment；改错故障 原地修改旧对象。',
      '//',
      '// 模块职责：按工作区与源路径分桶缓存代码评论预览。',
      '// 状态所有权：预览桶全部归 Zustand store；模块无其他可变状态。',
      '// 阅读顺序：先看桶键构造，再看添加与删除，最后看按来源删除与清空。',
    ],
    blocks: [
      {
        anchor: 'const EMPTY_CODE_COMMENT_PREVIEWS: CodeCommentPreview[] = [];',
        lines: [
          '空数组作为稳定引用。',
          '避免每次返回新数组。',
          '消费方据此跳过重渲染。',
          '不得向该常量写入。',
        ],
      },
      {
        anchor: 'export function buildCodeCommentPreviewBucketKey({',
        lines: [
          '工作区键与源路径拼接。',
          '分隔符选择空字符。',
          '同名文件在不同工作区隔离。',
        ],
      },
      {
        anchor: 'export const useCodeCommentPreviewStore = create<CodeCommentPreviewStoreState>(',
        lines: [
          '单一 store 持有预览桶。',
          '所有写入通过 set。',
          '读取走 get 取当前快照。',
          '不在此层做持久化。',
        ],
      },
      {
        anchor: 'addComment: (params) => {',
        lines: [
          '同 id 先移除再追加。',
          '追加保持原有顺序。',
          '只创建新桶对象。',
        ],
      },
      {
        anchor: 'removeCommentBySource: (payload) => {',
        lines: [
          '只扫描同一工作区的桶。',
          '未命中返回原状态。',
          '命中才产生新对象。',
        ],
      },
    ],
  },
  {
    file: 'packages/ui/src/store/pluginManagementStoreEnabled.ts',
    target: 40,
    header: [
      '// INV-01 请求序号单调递增：守住位置 模块计数；改错故障 过期响应覆盖新状态。',
      '// INV-02 在途请求按 store 隔离：守住位置 弱映射；改错故障 多窗口互相取消。',
      '// INV-03 请求键含工作区与插件：守住位置 buildToggleRequestKey；改错故障 不同作用域串扰。',
      '// INV-04 缺工作区直接失败：守住位置 入口判断；改错故障 无上下文也发请求。',
      '// INV-05 乐观投影先行：守住位置 set 调用；改错故障 开关长时间无响应。',
      '// INV-06 投影同时记录失败标记：守住位置 set 字段；改错故障 旧失败提示残留。',
      '// INV-07 插件快照用于回滚：守住位置 previousPlugin；改错故障 失败后无法恢复。',
      '// INV-08 响应需校验是否当前请求：守住位置 isCurrentRequest；改错故障 旧响应覆盖新写入。',
      '// INV-09 非当前请求只通知不落库：守住位置 早退分支；改错故障 过期结果写回状态。',
      '// INV-10 成功后以服务端结果为准：守住位置 结果投影；改错故障 本地状态与服务端分叉。',
      '// INV-11 成功后刷新列表：守住位置 loadInto；改错故障 其他插件状态陈旧。',
      '// INV-12 成功后通知变更：守住位置 notifyPluginManagementChange；改错故障 其他窗口不刷新。',
      '// INV-13 失败返回 false：守住位置 返回值；改错故障 调用方误判成功。',
      '// INV-14 失败仅当前请求才回滚：守住位置 条件判断；改错故障 覆盖后续操作。',
      '// INV-15 失败记录插件标识：守住位置 lastFailedPluginId；改错故障 界面无法定位。',
      '// INV-16 失败信息统一转换：守住位置 toMessage；改错故障 非 Error 值丢失。',
      '// INV-17 结束清除切换标记：守住位置 finally；改错故障 开关永久禁用。',
      '// INV-18 结束清理请求记录：守住位置 条件删除；改错故障 映射无限增长。',
      '//',
      '// 模块职责：以乐观更新方式启停插件，并处理过期响应与失败回滚。',
      '// 状态所有权：插件状态归 store；在途请求记录归模块级弱映射。',
      '// 阅读顺序：先看请求键与序号，再看乐观投影，最后看成功与失败收尾。',
    ],
    blocks: [
      {
        anchor: 'let nextToggleRequestId = 0;',
        lines: [
          '请求序号单调递增。',
          '用于识别过期响应。',
          '进程内计数已经足够。',
        ],
      },
      {
        anchor: 'const requestsByStore = new WeakMap<() => PluginManagementState, Map<string, number>>();',
        lines: [
          '按 store 隔离在途请求。',
          '键为切换请求键。',
          '弱引用避免长期持有。',
        ],
      },
      {
        anchor: 'function buildToggleRequestKey(input: {',
        lines: [
          '工作区键先归一。',
          '作用域缺省为有效。',
          '插件标识作末段。',
        ],
      },
      {
        anchor: 'export async function setPluginEnabledOptimistically(',
        lines: [
          '先乐观投影再发请求。',
          '失败恢复原插件快照。',
          '返回布尔表示结果是否仍有效。',
        ],
      },
      {
        anchor: 'const { workspacePath, workspaceIdentity, authorityKey, configScope } = get();',
        lines: [
          '缺少工作区直接失败。',
          '身份与权限键一并取出。',
          '作用域参与请求键构造。',
        ],
      },
      {
        anchor: 'const isCurrentRequest = (): boolean => {',
        lines: [
          '序号与请求键都要匹配。',
          '上下文快照必须一致。',
          '切换中的插件也需匹配。',
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
    const anchor =
      block.anchorLine === undefined
        ? block.anchor
        : srcLines[block.anchorLine - 1].replace(/\r$/, '').trim();
    const item = { anchor, lines: block.lines };
    if (block.nth !== undefined) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(
    `ZC-deep-b148-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
