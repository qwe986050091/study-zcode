import { readFileSync, writeFileSync } from 'node:fs'

const file = 'd:/code/claude-code-main/entrypoints/sdk/controlSchemas.ts'
let text = readFileSync(file, 'utf8')

const pairs = [
  ['代理定义表：名字 → 定义，注册后可按名字调用。', 'agents：代理定义表，名字 → 定义，注册后可按名字调用。'],
  ['当前可用代理列表，含名称与描述级信息。', 'agents：当前可用代理列表，含名称与描述级信息。'],
  ['当前生效的输出风格名。', 'output_style：当前生效的输出风格名。'],
  ['可切换的全部输出风格名。', 'available_output_styles：可切换的全部输出风格名。'],
  ['可切换的模型列表，含能力与定价信息。', 'models：可切换的模型列表，含能力与定价信息。'],
  ['目标模型名；缺省表示回到默认模型。', 'model：目标模型名；缺省表示回到默认模型。'],
  ['分类是否被延后加载。', 'isDeferred：分类是否被延后加载。'],
  ['方格配色，与分类配色一致。', 'color：方格配色，与分类配色一致。'],
  ['方格是否已被填满。', 'isFilled：方格是否已被填满。'],
  ['方格所属分类名。', 'categoryName：方格所属分类名。'],
  ['按分类聚合的占用明细。', 'categories：按分类聚合的占用明细。'],
  ['方格图，外层行、内层列。', 'gridRows：方格图，外层行、内层列。'],
  ['延后加载的内建工具。', 'deferredBuiltinTools：延后加载的内建工具。'],
  ['系统工具列表。', 'systemTools：系统工具列表。'],
  ['系统提示各段落的占用。', 'systemPromptSections：系统提示各段落的占用。'],
  ['子代理上下文的占用。', 'agents：子代理上下文的占用。'],
  ['斜杠命令的汇总占用。', 'slashCommands：斜杠命令的汇总占用。'],
  ['自动压缩当前是否开启。', 'isAutoCompactEnabled：自动压缩当前是否开启。'],
  ['实际新增的服务器名。', 'added：实际新增的服务器名。'],
  ['实际移除的服务器名。', 'removed：实际移除的服务器名。'],
  ['重扫后的斜杠命令。', 'commands：重扫后的斜杠命令。'],
  ['重扫后的代理列表。', 'agents：重扫后的代理列表。'],
  ['重扫后的插件条目。', 'plugins：重扫后的插件条目。'],
  ['目标服务器名（历史驼峰命名，不可改）。', 'serverName：目标服务器名（历史驼峰命名，不可改）。'],
  ['磁盘各层合并后的设置。', 'effective：磁盘各层合并后的设置。'],
  ['来源层名。', 'source：来源层名。'],
  ['来源层的原始设置。', 'settings：来源层的原始设置。'],
  ['最终生效的模型名。', 'model：最终生效的模型名。'],
  ['最终生效的思考强度。', 'effort：最终生效的思考强度。'],
  ['被响应的请求 id。', 'request_id：被响应的请求 id。'],
  ['要取消的请求 id。', 'request_id：要取消的请求 id。'],
  ['要覆盖的环境变量键值。', 'variables：要覆盖的环境变量键值。'],
]

for (const [oldText, newText] of pairs) {
  const needle = `// ${oldText}`
  const idx = text.indexOf(needle)
  if (idx === -1) {
    console.error('MISS', oldText)
    continue
  }
  text = text.slice(0, idx) + `// ${newText}` + text.slice(idx + needle.length)
}

writeFileSync(file, text, 'utf8')
console.log('done')
