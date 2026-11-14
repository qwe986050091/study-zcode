import fs from 'node:fs';

const specs = [
  {
    file: 'packages/server/src/remote/wsl-detect.ts',
    target: 40,
    header: [
      '// INV-01 非 Windows 直接判不可用：守住位置 平台判断；改错故障 非 Windows 调用外部命令。',
      '// INV-02 空输出返回空串：守住位置 长度判断；改错故障 解码空缓冲出错。',
      '// INV-03 含零字节走 UTF-16：守住位置 字节判断；改错故障 行内夹满零字符。',
      '// INV-04 其余按 UTF-8 解码：守住位置 回退；改错故障 普通输出乱码。',
      '// INV-05 归一化去零与 BOM：守住位置 清洗链；改错故障 首行带不可见字符。',
      '// INV-06 CR 统一去除：守住位置 替换；改错故障 行尾残留回车。',
      '// INV-07 空白行先过滤：守住位置 过滤；改错故障 解析出空发行。',
      '// INV-08 至少三段才算发行：守住位置 长度判断；改错故障 标题行被当发行。',
      '// INV-09 版本取末段：守住位置 倒数第一；改错故障 名称被当版本。',
      '// INV-10 非数字版本跳过：守住位置 有限数判断；改错故障 版本写成非法值。',
      '// INV-11 状态取倒数第二：守住位置 取值；改错故障 状态与名称错位。',
      '// INV-12 默认标记单独识别：守住位置 星号判断；改错故障 名称带星号。',
      '// INV-13 名称去星后非空才收：守住位置 非空判断；改错故障 收录空名发行。',
      '// INV-14 版本仅接受一二：守住位置 白名单；改错故障 出现版本三。',
      '// INV-15 缓存按执行器隔离：守住位置 弱映射；改错故障 不同执行器共享结果。',
      '// INV-16 缓存只在成功期内复用：守住位置 过期判断；改错故障 过期仍返回旧值。',
      '// INV-17 失败即删缓存：守住位置 捕获；改错故障 拒绝态固化到过期。',
      '// INV-18 支持显式失效：守住位置 失效函数；改错故障 安装后仍读旧列表。',
      '//',
      '// 模块职责：WSL 可用性与发行版列表的探测、解析与短缓存。',
      '// 状态所有权：探测结果按执行器缓存，外部可显式失效。',
      '// 阅读顺序：先看输出解码与解析，再看缓存，最后看两个探测入口。',
    ],
    blocks: [
      {
        anchor: 'function decodeWslOutput(buffer: Buffer): string {',
        lines: [
          '空缓冲直接返回空串。',
          '含零字节按 UTF-16 解。',
          '其余按 UTF-8 解。',
          '两种编码都要兼容。',
          '不修改入参。',
        ],
      },
      {
        anchor: 'export function parseWSLDistroList(rawOutput: string): WSLDistro[] {',
        lines: [
          '先归一化再分行。',
          '空行先过滤。',
          '至少三段才解析。',
          '名称去默认星号。',
          '版本只接受一二。',
        ],
      },
      {
        anchor: 'function getCachedDiscovery<T>(',
        lines: [
          '命中未过期即复用。',
          '未命中执行加载。',
          '失败删除缓存。',
          '缓存按执行器隔离。',
        ],
      },
      {
        anchor: 'export async function isWSLAvailable(',
        lines: [
          '非 Windows 直接否。',
          '状态命令成功即可用。',
          '未识别命令视为不可用。',
          '其余错误仍视为可用。',
        ],
      },
    ],
  },
  {
    file: 'packages/server/src/remote/wslProxy.ts',
    target: 40,
    header: [
      '// INV-01 空串返回空：守住位置 修剪判断；改错故障 空地址被补成默认主机。',
      '// INV-02 无协议补默认协议：守住位置 协议探测；改错故障 纯主机地址解析失败。',
      '// INV-03 解析失败返回空：守住位置 捕获；改错故障 抛错打断调用方。',
      '// INV-04 回环含三种写法：守住位置 判断；改错故障 localhost 被当远端。',
      '// INV-05 方括号先剥除：守住位置 归一化；改错故障 IPv6 回环漏判。',
      '// INV-06 替换主机保留端口：守住位置 地址重建；改错故障 端口丢失。',
      '// INV-07 IPv6 主机补方括号：守住位置 地址类型；改错故障 生成非法地址。',
      '// INV-08 探测命令默认端口：守住位置 缺省；改错故障 无端口地址探测失败。',
      '// INV-09 非数字端口返回空：守住位置 正则；改错故障 命令注入。',
      '// INV-10 探测脚本统一引用：守住位置 引用函数；改错故障 空格参数被拆分。',
      '// INV-11 网关命令分别输出来源：守住位置 标签前缀；改错故障 无法区分路由与解析。',
      '// INV-12 网关解析逐词扫描：守住位置 分词；改错故障 首个候选错误即放弃。',
      '// INV-13 回环与本地链路排除：守住位置 候选判断；改错故障 选到回环地址。',
      '// INV-14 解析来源要求私网：守住位置 私网判断；改错故障 公网地址被当网关。',
      '// INV-15 IPv6 私网段识别：守住位置 前缀判断；改错故障 唯一本地地址被丢弃。',
      '// INV-16 日志格式隐藏路径：守住位置 协议与主机；改错故障 凭据写进日志。',
      '// INV-17 非法地址给占位：守住位置 捕获；改错故障 日志记录抛错。',
      '// INV-18 不修改输入字符串：守住位置 纯函数；改错故障 调用方地址被改写。',
      '//',
      '// 模块职责：WSL 代理地址的规范化、端口探测命令与宿主网关解析。',
      '// 状态所有权：全部为纯函数，不持有连接或缓存。',
      '// 阅读顺序：先看地址规范化，再看探测命令，最后看网关候选判定。',
    ],
    blocks: [
      {
        anchor: 'export function normalizeWslProxyUrl(value: string): string | null {',
        lines: [
          '空串返回空。',
          '无协议补默认协议。',
          '解析失败返回空。',
          '协议与主机都需非空。',
          '返回规范字符串。',
        ],
      },
      {
        anchor: 'export function buildWslProxyPortProbeCommand(proxyUrl: string): string | null {',
        lines: [
          '解析失败返回空。',
          '端口缺省按协议。',
          '端口必须是数字。',
          '主机保留 IPv6 方括号。',
          '脚本参数统一引用。',
        ],
      },
      {
        anchor: 'export function parseWslHostGatewayOutput(output: string): string | null {',
        lines: [
          '逐词扫描候选。',
          '标签区分来源。',
          '先命中先返回。',
          '全部不合格返回空。',
        ],
      },
      {
        anchor: 'function isWslGatewayCandidate(candidate: string, source: string): boolean {',
        lines: [
          '必须是合法地址。',
          '回环地址排除。',
          '解析来源只收私网。',
          '路由来源可直接采用。',
        ],
      },
    ],
  },
  {
    file: 'packages/model-option-map/src/tokenizer.ts',
    target: 40,
    header: [
      '// INV-01 空白跳过不产词：守住位置 空白判断；改错故障 解析器收到空白。',
      '// INV-02 字符串分支优先：守住位置 引号判断；改错故障 引号被当运算符。',
      '// INV-03 数字只接受规范写法：守住位置 正则；改错故障 前导零被接受。',
      '// INV-04 标识符首字符限字母下划线：守住位置 判断；改错故障 数字开头名字被拆开。',
      '// INV-05 双字符运算符优先：守住位置 先查两字符；改错故障 大于号被拆成两个。',
      '// INV-06 单字符运算符兜底：守住位置 集合；改错故障 合法运算符被拒。',
      '// INV-07 标点独立分类：守住位置 集合；改错故障 括号混进运算符。',
      '// INV-08 未知字符即报错：守住位置 末尾抛错；改错故障 静默吞掉输入。',
      '// INV-09 末尾必有结束标记：守住位置 收尾推入；改错故障 解析器越界。',
      '// INV-10 词表冻结：守住位置 冻结调用；改错故障 下游改写词法结果。',
      '// INV-11 偏移为起点终点：守住位置 字段；改错故障 报错位置错位。',
      '// INV-12 字符串不允许换行：守住位置 换行判断；改错故障 跨行字符串被接受。',
      '// INV-13 转义缺失即报错：守住位置 未定义判断；改错故障 截断处静默结束。',
      '// INV-14 简单转义查表：守住位置 映射；改错故障 反斜杠丢失。',
      '// INV-15 Unicode 转义限四位：守住位置 长度与格式；改错故障 非法码点通过。',
      '// INV-16 数字不吞前导零：守住位置 正则；改错故障 零被吃掉。',
      '// INV-17 标识符允许数字续写：守住位置 续写判断；改错故障 名字被截断。',
      '// INV-18 全部函数无外部状态：守住位置 纯函数；改错故障 并发解析互相污染。',
      '//',
      '// 模块职责：受限 CEL 子集的词法分析。',
      '// 状态所有权：无状态，全部输入来自源字符串。',
      '// 阅读顺序：先看主循环，再看字符串与数字读取，最后看续读工具。',
    ],
    blocks: [
      {
        anchor: 'export function tokenizeRestrictedCel(source: string): readonly RestrictedCelToken[] {',
        lines: [
          '空白直接跳过。',
          '依次尝试字符串数字标识符。',
          '双字符运算符优先。',
          '未知字符立即报错。',
          '末尾补结束标记。',
        ],
      },
      {
        anchor: 'function readString(source: string, offset: number, quote: "\'" | \'"\'): RestrictedCelToken {',
        lines: [
          '逐字符累积。',
          '遇到同引号结束。',
          '换行视为未终止。',
          '反斜杠进入转义。',
          '结束偏移含右引号。',
        ],
      },
      {
        anchor: 'function readNumber(source: string, offset: number): RestrictedCelToken {',
        lines: [
          '匹配规范数字。',
          '不匹配即报错。',
          '记录起止偏移。',
          '不转换数值类型。',
        ],
      },
      {
        anchor: 'function readWhile(source: string, offset: number, pattern: RegExp): number {',
        lines: [
          '逐字符匹配。',
          '停止于首个不匹配。',
          '返回结束偏移。',
          '不修改源串。',
        ],
      },
    ],
  },
];

let index = 0;
for (const spec of specs) {
  const srcLines = fs.readFileSync('D:/code/ZCode/' + spec.file, 'utf8').split('\n');
  const firstAuto = srcLines[0].replace(/\r$/, '').trim();
  const firstAnchor = spec.first ?? firstAuto;
  if (spec.first && firstAnchor !== firstAuto) {
    console.error(`FIRST MISMATCH ${spec.file}\n  spec: ${spec.first}\n  file: ${firstAuto}`);
    process.exit(1);
  }
  const firstItem = { anchor: firstAnchor, raw: spec.header };
  if (spec.firstNth) firstItem.nth = spec.firstNth;
  const items = [firstItem];
  for (const block of spec.blocks) {
    const item = { anchor: block.anchor, lines: block.lines };
    if (block.nth) item.nth = block.nth;
    items.push(item);
  }
  const total = spec.header.length + spec.blocks.reduce((n, b) => n + b.lines.length, 0);
  if (total !== spec.target) {
    console.error(`TARGET MISMATCH ${spec.file}: ${total} != ${spec.target}`);
    process.exit(1);
  }
  fs.writeFileSync(`ZC-deep-b135-spec-${index}.json`, JSON.stringify({ files: [{ file: spec.file, items }] }, null, 2), 'utf8');
  console.log(`spec ${index}: ${spec.file} lines=${total}`);
  index += 1;
}
