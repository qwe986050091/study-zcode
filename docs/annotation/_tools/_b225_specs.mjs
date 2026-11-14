// B225 四个文件的注释 spec 生成器（各新增 30 行）。
import fs from 'node:fs';

const specs = [
  {
    file: 'packages/desktop/src/renderer/src/plugin-sandbox/relay.ts',
    target: 30,
    header: [
      '// INV-01 纯转发不解析：守住位置 handleFrameMessage；改错故障 shell 变成第二个协议实现。',
      '// INV-02 协议状态在宿主：守住位置 本文件无握手/超时；改错故障 两处状态机互相打架。',
      '// INV-03 allow 白名单唯一：守住位置 PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS；改错故障 iframe 拿到未授权特性。',
      '// INV-04 allow 去重保序：守住位置 Set 展开；改错故障 重复 token 让 allow 串变长且顺序漂移。',
      '// INV-05 非串即空：守住位置 typeof 判断；改错故障 数组被强转成逗号串。',
      '// INV-06 身份解析失败即 null：守住位置 三处 return null；改错故障 畸形 origin 造出可预测的插件地址。',
      '// INV-07 app 身份必须 64 位十六进制：守住位置 正则；改错故障 任意 host 都能映射成插件 origin。',
      '// INV-08 sandboxId 取自路径段：守住位置 pathname.split("/")[2]；改错故障 多实例共用同一页面。',
      '// INV-09 init 结构强校验：守住位置 五个字段判断；改错故障 伪造 init 抢占端口。',
      '// INV-10 sandboxId 必须匹配：守住位置 deps.sandboxId 比较；改错故障 串线帧接到别的 sandbox。',
      '// INV-11 端口唯一：守住位置 ports.length !== 1；改错故障 多端口时转发目标不确定。',
      '// INV-12 重复 init 保留首个：守住位置 if (port) 分支；改错故障 后到端口覆盖在用连接。',
      '// INV-13 转发带固定 origin：守住位置 postMessage 第二参 deps.pluginOrigin；改错故障 消息投递到错误源。',
      '// INV-14 dispose 幂等且可重入：守住位置 disposed 早退；改错故障 二次销毁访问已释放端口。',
      '//',
      '// 模块职责：插件沙箱 shell 的转发内核，只做身份解析、allow 过滤与端口接线。',
      '// 阅读顺序：先看 allow 白名单，再看身份解析，最后看 relay 的 init 与销毁生命周期。',
    ],
    blocks: [
      {
        anchor: 'export const PLUGIN_SANDBOX_IFRAME_ALLOW_TOKENS: readonly string[] = [',
        lines: [
          '四个特性与主进程权限闸门同集。',
        ],
      },
      {
        anchor: 'export function sanitizePluginSandboxIframeAllow(value: unknown): string {',
        lines: [
          '过滤只保留白名单内的 token。',
        ],
      },
      {
        anchor: 'if (typeof value !== "string") return "";',
        lines: [
          '非字符串一律当作未声明。',
        ],
      },
      {
        anchor: 'return [...new Set(tokens)].join("; ");',
        lines: [
          '去重后按原顺序重排。',
        ],
      },
      {
        anchor: 'export function resolvePluginSandboxShellIdentity(origin: string): {',
        lines: [
          '从 shell 自身 origin 反推插件位置。',
        ],
      },
      {
        anchor: 'if (!appIdentity || !/^[a-f0-9]{64}$/.test(appIdentity)) return null;',
        lines: [
          '身份必须是完整摘要，防止伪造。',
        ],
      },
      {
        anchor: 'export function createPluginSandboxRelay(deps: {',
        lines: [
          '依赖全部注入，便于在 shell 内测试。',
        ],
      },
      {
        anchor: 'handleInit(data, ports) {',
        lines: [
          'init 帧是唯一建立连接的入口。',
        ],
      },
      {
        anchor: 'if (init.sandboxId !== deps.sandboxId) {',
        lines: [
          '别的 sandbox 的 init 只记日志。',
        ],
      },
      {
        anchor: 'if (!incoming || ports.length !== 1) {',
        lines: [
          '缺端口或多端口都视为协议错误。',
        ],
      },
      {
        anchor: 'if (port) {',
        lines: [
          '重复 init 关掉新端口，保留首个。',
        ],
      },
      {
        anchor: 'frame = deps.createPluginFrame(deps.pluginUrl, sanitizePluginSandboxIframeAllow(init.allow));',
        lines: [
          'iframe 的 allow 必须先过白名单。',
        ],
      },
      {
        anchor: 'dispose() {',
        lines: [
          '销毁关闭端口、移除 iframe 并置空。',
        ],
      },
    ],
  },
  {
    file: 'packages/model-option-map/src/merge-patch.ts',
    target: 30,
    header: [
      '// INV-01 顺序应用：守住位置 for (const namedPatch of patches)；改错故障 后写覆盖先写而无法定位来源。',
      '// INV-02 冲突即失败：守住位置 throw ModelOptionMapError；改错故障 两个插件静默互相覆盖。',
      '// INV-03 重叠含祖先关系：守住位置 pathsOverlap 前缀比较；改错故障 $.a 与 $.a.b 被当成不相干。',
      '// INV-04 写入路径先收集：守住位置 collectWrittenPaths 在建树前调用；改错故障 冲突检测滞后于合并。',
      '// INV-05 空对象不算写入：守住位置 length > 0 判断；改错故障 空 patch 与任何路径冲突。',
      '// INV-06 合并基于克隆：守住位置 cloneJson(body)；改错故障 直接改写调用方入参。',
      '// INV-07 null 表示删除：守住位置 patchValue === null；改错故障 RFC 7386 语义丢失，字段变成 null。',
      '// INV-08 非对象目标按空对象处理：守住位置 isJsonObject(targetValue) 三元；改错故障 标量目标上抛错。',
      '// INV-09 叶子值整体替换：守住位置 最后一行赋值；改错故障 数组被逐项合并。',
      '// INV-10 数组视为叶子：守住位置 isJsonObject 排除 Array；改错故障 数组被当对象展开。',
      '// INV-11 克隆用空原型：守住位置 Object.create(null)；改错故障 __proto__ 键污染原型链。',
      '// INV-12 键用 defineProperty：守住位置 逐个定义；改错故障 特殊键触发 setter 或丢属性。',
      '// INV-13 路径格式化固定：守住位置 "$" 与 "$.a.b"；改错故障 报错信息不可读。',
      '// INV-14 纯函数无 IO：守住位置 全部导出；改错故障 冲突检测读取环境或写日志。',
      '//',
      '// 模块职责：按顺序应用带来源名的 JSON Merge Patch，并在写入路径重叠时报错。',
      '// 阅读顺序：先看顺序应用与冲突检测，再看路径收集，最后看合并与克隆的边界。',
    ],
    blocks: [
      {
        anchor: 'export interface NamedJsonMergePatch {',
        lines: [
          '补丁必须带来源名用于冲突归因。',
        ],
      },
      {
        anchor: 'export function applyOrderedJsonMergePatches(',
        lines: [
          '对外只暴露顺序应用入口。',
        ],
      },
      {
        anchor: 'const paths = collectWrittenPaths(namedPatch.patch);',
        lines: [
          '先算本条写入哪些路径。',
        ],
      },
      {
        anchor: 'const conflict = ownedPaths.find((owned) => pathsOverlap(owned.path, path));',
        lines: [
          '与已登记路径做前缀重叠判断。',
        ],
      },
      {
        anchor: 'result = mergeObject(result, namedPatch.patch);',
        lines: [
          '冲突检查通过后才真正合并。',
        ],
      },
      {
        anchor: 'function collectWrittenPaths(',
        lines: [
          '递归列出所有叶子写入路径。',
        ],
      },
      {
        anchor: 'if (isJsonObject(value) && Object.keys(value).length > 0) {',
        lines: [
          '非空对象继续下钻，空对象即叶子。',
        ],
      },
      {
        anchor: 'function pathsOverlap(left: readonly string[], right: readonly string[]): boolean {',
        lines: [
          '公共前缀全部相同即视为重叠。',
        ],
      },
      {
        anchor: 'function mergeObject(target: JsonObject, patch: JsonObject): JsonObject {',
        lines: [
          '合并始终在克隆上执行。',
        ],
      },
      {
        anchor: 'if (patchValue === null) {',
        lines: [
          'null 表示删除该键。',
        ],
      },
      {
        anchor: 'result[key] = mergeObject(isJsonObject(targetValue) ? targetValue : {}, patchValue);',
        lines: [
          '目标不是对象时按空对象起步。',
        ],
      },
      {
        anchor: 'function cloneJson(value: JsonValue): JsonValue {',
        lines: [
          '克隆同时隔离数组与对象。',
        ],
      },
      {
        anchor: 'const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;',
        lines: [
          '空原型避免原型链键污染。',
        ],
      },
    ],
  },
  {
    file: 'packages/provider-node/src/endpoint-scoped-zcode-builtin-source.ts',
    target: 30,
    header: [
      '// INV-01 Endpoint 决定全部路径：守住位置 resolveZCodeBuiltinCachePaths 入参；改错故障 切换控制面后仍读旧缓存。',
      '// INV-02 切换不继承旧缓存：守住位置 #resolveCurrent 新建 source；改错故障 跨 Endpoint 读到上一环境的配置。',
      '// INV-03 并发只解析一次：守住位置 #ensureInFlight；改错故障 首启并发读触发多份 watcher。',
      '// INV-04 in-flight 自清理：守住位置 finally 内的相等判断；改错故障 失败的 Promise 被永久缓存。',
      '// INV-05 路径未变即复用：守住位置 activeFilePath 比较；改错故障 每次读都重建 watcher 与同步器。',
      '// INV-06 构造失败必须回滚：守住位置 catch 内三段 dispose；改错故障 半初始化对象泄漏文件监听。',
      '// INV-07 先读后发布：守住位置 await source.read() 在赋值前；改错故障 上层拿到尚未物化的快照。',
      '// INV-08 旧实例最后销毁：守住位置 previous?.dispose() 在赋值后；改错故障 事件间隙出现无监听窗口。',
      '// INV-09 切换必须通知：守住位置 #emit("endpoint-changed")；改错故障 上层不知道配置已换源。',
      '// INV-10 销毁后拒绝使用：守住位置 #assertNotDisposed；改错故障 卸载后仍能建立新 watcher。',
      '// INV-11 销毁幂等：守住位置 #disposed 早退；改错故障 重复销毁清空已释放的监听集合。',
      '// INV-12 监听器异常不外溢：守住位置 #emit 的单向遍历；改错故障 一个订阅者抛错阻断其余订阅者。',
      '// INV-13 子资源成组释放：守住位置 CurrentEndpointSource.dispose；改错故障 漏掉 sourceDispose 留下监听。',
      '// INV-14 resolveEndpointOrigin 可异步：守住位置 await 两次；改错故障 环境读取为异步时得到 Promise 字符串。',
      '//',
      '// 模块职责：把 ZCode 内置 provider 的缓存与同步绑定到当前控制面 Endpoint，并支持热切换。',
      '// 阅读顺序：先看公共读接口，再看 ensureCurrent 的并发与复用，最后看切换时的销毁顺序。',
    ],
    blocks: [
      {
        anchor: 'export interface EndpointScopedZCodeBuiltinSourceOptions {',
        lines: [
          '依赖全部注入，Endpoint 以函数给出。',
        ],
      },
      {
        anchor: 'export class EndpointScopedZCodeBuiltinSource implements ProviderSource<ProviderConfigLayerSnapshot> {',
        lines: [
          '对外表现为一个普通 provider 源。',
        ],
      },
      {
        anchor: 'async read(): Promise<ProviderConfigLayerSnapshot> {',
        lines: [
          '所有读操作都先确保当前源。',
        ],
      },
      {
        anchor: 'onDidChange(listener: (reason: string) => void): () => void {',
        lines: [
          '退订函数直接删除监听器。',
        ],
      },
      {
        anchor: 'async refresh(options?: { readonly force?: boolean }): Promise<ZCodeBuiltinRefreshResult> {',
        lines: [
          '刷新作用于当前 Endpoint 的同步器。',
        ],
      },
      {
        anchor: 'async resolveActiveFilePath(): Promise<string> {',
        lines: [
          '物化路径用于外部诊断与展示。',
        ],
      },
      {
        anchor: 'async #ensureCurrent(): Promise<CurrentEndpointSource> {',
        lines: [
          '并发读共享同一次解析。',
        ],
      },
      {
        anchor: 'if (this.#ensureInFlight) return this.#ensureInFlight;',
        lines: [
          '在飞 Promise 直接复用。',
        ],
      },
      {
        anchor: 'async #resolveCurrent(): Promise<CurrentEndpointSource> {',
        lines: [
          '解析 Endpoint 并对照当前路径。',
        ],
      },
      {
        anchor: 'if (this.#current?.activeFilePath === paths.activeFilePath) return this.#current;',
        lines: [
          '路径相同则完全复用现有实例。',
        ],
      },
      {
        anchor: 'try {',
        lines: [
          '先物化一次，成功才对外发布。',
        ],
      },
      {
        anchor: 'previous?.dispose();',
        lines: [
          '新实例就位后才销毁旧实例。',
        ],
      },
      {
        anchor: '#assertNotDisposed(): void {',
        lines: [
          '已销毁再调用立即抛错。',
        ],
      },
    ],
  },
  {
    file: 'packages/shared/src/source-server/connectionErrors.ts',
    target: 30,
    header: [
      '// INV-01 归一化不抛错：守住位置 visit 的所有分支；改错故障 错误处理本身成为新的崩溃源。',
      '// INV-02 防环：守住位置 seen 集合；改错故障 自引用 cause 导致栈溢出。',
      '// INV-03 已确认领域码优先：守住位置 explicitCode 早返回；改错故障 阶段兜底覆盖真实原因。',
      '// INV-04 阶段码不算确认原因：守住位置 phaseCodes 排除；改错故障 外层包装码压掉内层认证失败。',
      '// INV-05 内层更具体者优先：守住位置 递归 visit(child)；改错故障 AggregateError 只报笼统失败。',
      '// INV-06 外层文案仍可用：守住位置 合并时回退 nested.message；改错故障 内层无文案时丢失上下文。',
      '// INV-07 遍历顺序稳定：守住位置 errors → cause → error；改错故障 同一批错误产出不同结果。',
      '// INV-08 系统错误码表：守住位置 systemCodes；改错故障 ECONNRESET 被改写成 preflight 失败。',
      '// INV-09 名称兜底：守住位置 AbortError 判断；改错故障 取消被当未知错误。',
      '// INV-10 文本猜测有优先级：守住位置 逐个 !code 守卫；改错故障 先匹配的宽泛正则吞掉具体原因。',
      '// INV-11 身份变化只认明确文案：守住位置 HOST IDENTIFICATION / host key verification；改错故障 普通握手失败被误报为中间人。',
      '// INV-12 阶段兜底只在顶层：守住位置 visit(error, true)；改错故障 内层 cause 被套上外层阶段码。',
      '// INV-13 文案必然非空：守住位置 || "Remote connection failed"；改错故障 空聚合错误产出空消息。',
      '// INV-14 retryable 原样透传：守住位置 typeof boolean 判断；改错故障 字符串 true 被当可重试。',
      '//',
      '// 模块职责：把远端连接阶段的异构错误收敛成可展示、可判定的公开错误码。',
      '// 阅读顺序：先看两张码表，再看 visit 的确认码与递归，最后看文本猜测的优先级。',
    ],
    blocks: [
      {
        anchor: 'const systemCodes: Record<string, PublicZCodeErrorCode> = {',
        lines: [
          '系统错误码是最高置信度的映射。',
        ],
      },
      {
        anchor: 'const phaseCodes: Record<string, PublicZCodeErrorCode> = {',
        lines: [
          '阶段码只作顶层兜底，不作确认。',
        ],
      },
      {
        anchor: 'export function normalizeRemoteConnectionError(',
        lines: [
          '对外的唯一归一化入口。',
        ],
      },
      {
        anchor: 'function visit(value: unknown, applyPhaseFallback = false): RemoteConnectionFailure {',
        lines: [
          '递归访问，阶段兜底仅顶层可开。',
        ],
      },
      {
        anchor: 'if (seen.has(value))',
        lines: [
          '重复引用直接返回未知，防环。',
        ],
      },
      {
        anchor: 'const explicitCode = isPublicZCodeErrorCode(rawCode) ? rawCode : undefined;',
        lines: [
          '只有公开码表中存在的才算确认。',
        ],
      },
      {
        anchor: 'for (const child of [',
        lines: [
          '按 errors、cause、error 顺序下钻。',
        ],
      },
      {
        anchor: 'if (nested.code !== "remote-connection-unknown")',
        lines: [
          '内层有结论就用内层，外层补文案。',
        ],
      },
      {
        anchor: 'let code = explicitCode ?? systemCodes[rawCode];',
        lines: [
          '先查表，再进入文本猜测。',
        ],
      },
      {
        anchor: 'if (!code && record.name === "AbortError") code = "remote-connection-canceled";',
        lines: [
          '取消以错误名为准。',
        ],
      },
      {
        anchor: 'code = "remote-authentication-failed";',
        lines: [
          '认证失败按双语文案识别。',
        ],
      },
      {
        anchor: 'code = "remote-host-key-changed";',
        lines: [
          '只认明确的 host key 变更文案。',
        ],
      },
      {
        anchor: 'return visit(error, true);',
        lines: [
          '仅最外层允许阶段码兜底。',
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
    `ZC-deep-b225-spec-${index}.json`,
    JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2),
    'utf8',
  );
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
