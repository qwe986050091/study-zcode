// 生成 LangGraph 批次规划表（临时工具）
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/lg-measure.json', 'utf8').replace(/^\uFEFF/, ''));
const m = new Map(d.files.map((f) => [f.rel, f]));
const L = 'libs/langgraph/langgraph/';
const ch = ['__init__.py', 'any_value.py', 'base.py', 'binop.py', 'delta.py', 'ephemeral_value.py', 'last_value.py', 'named_barrier_value.py', 'topic.py', 'untracked_value.py'];
const serde = ['__init__.py', '_msgpack.py', 'base.py', 'encrypted.py', 'event_hooks.py', 'types.py'];
const B = [
  ['B01', [L + 'pregel/main.py']],
  ['B02', [L + 'pregel/main.py']],
  ['B03', [L + 'pregel/_loop.py']],
  ['B04', [L + 'graph/state.py']],
  ['B05', [L + 'pregel/_algo.py']],
  ['B06', [L + 'pregel/remote.py', L + 'pregel/_remote_run_stream.py']],
  ['B07', [L + 'pregel/_runner.py', L + 'pregel/_executor.py', L + 'pregel/_retry.py']],
  ['B08', [L + 'pregel/_checkpoint.py', L + 'pregel/_messages.py', L + 'pregel/_read.py', L + 'pregel/_write.py']],
  ['B09', [L + 'pregel/_call.py', L + 'pregel/_draw.py', L + 'pregel/_io.py', L + 'pregel/_task_status.py', L + 'pregel/_tools.py', L + 'pregel/_utils.py']],
  ['B10', [L + 'pregel/_validate.py', L + 'pregel/debug.py', L + 'pregel/protocol.py', L + 'pregel/types.py', L + 'pregel/_log.py', L + 'pregel/_config.py']],
  ['B11', [L + 'stream/transformers.py', L + 'stream/stream_channel.py']],
  ['B12', [L + 'stream/run_stream.py', L + 'stream/_mux.py', L + 'stream/_types.py', L + 'stream/__init__.py', L + 'stream/_convert.py']],
  ['B13', ch.map((x) => L + 'channels/' + x)],
  ['B14', [L + '_internal/_runnable.py', L + '_internal/_config.py', L + '_internal/_future.py']],
  ['B15', ['__init__.py', '_cache.py', '_constants.py', '_fields.py', '_pydantic.py', '_queue.py', '_replay.py', '_retry.py', '_scratchpad.py', '_serde.py', '_timeout.py', '_typing.py'].map((x) => L + '_internal/' + x)],
  ['B16', [L + 'graph/message.py', L + 'graph/_branch.py', L + 'graph/ui.py', L + 'graph/_node.py', L + 'graph/__init__.py']],
  ['B17', [L + 'types.py']],
  ['B18', [L + 'callbacks.py', L + 'errors.py', L + 'config.py', L + 'runtime.py', L + 'constants.py', L + 'typing.py', L + 'warnings.py']],
  ['B19', [L + 'func/__init__.py', L + 'managed/__init__.py', L + 'managed/base.py', L + 'managed/is_last_step.py', L + 'utils/__init__.py', L + 'utils/config.py', L + 'utils/runnable.py', L + 'version.py']],
  ['B20', ['libs/checkpoint/langgraph/checkpoint/base/__init__.py', 'libs/checkpoint/langgraph/checkpoint/base/id.py', 'libs/checkpoint/langgraph/checkpoint/memory/__init__.py']],
  ['B21', ['libs/checkpoint/langgraph/checkpoint/serde/jsonplus.py']],
  ['B22', serde.map((x) => 'libs/checkpoint/langgraph/checkpoint/serde/' + x).concat(['libs/checkpoint/langgraph/cache/base/__init__.py', 'libs/checkpoint/langgraph/cache/memory/__init__.py', 'libs/checkpoint/langgraph/cache/redis/__init__.py'])],
  ['B23', ['libs/checkpoint/langgraph/store/base/__init__.py']],
  ['B24', ['libs/checkpoint/langgraph/store/base/batch.py', 'libs/checkpoint/langgraph/store/base/embed.py', 'libs/checkpoint/langgraph/store/memory/__init__.py']],
  ['B25', ['libs/checkpoint-postgres/langgraph/checkpoint/postgres/__init__.py', 'libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py', 'libs/checkpoint-postgres/langgraph/checkpoint/postgres/aio.py']],
  ['B26', ['libs/checkpoint-postgres/langgraph/checkpoint/postgres/shallow.py', 'libs/checkpoint-postgres/langgraph/checkpoint/postgres/_internal.py', 'libs/checkpoint-postgres/langgraph/checkpoint/postgres/_ainternal.py']],
  ['B27', ['libs/checkpoint-postgres/langgraph/store/postgres/base.py']],
  ['B28', ['libs/checkpoint-postgres/langgraph/store/postgres/aio.py', 'libs/checkpoint-postgres/langgraph/store/postgres/__init__.py']],
  ['B29', ['libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py', 'libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/aio.py', 'libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/_delta.py', 'libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/utils.py']],
  ['B30', ['libs/checkpoint-sqlite/langgraph/store/sqlite/base.py']],
  ['B31', ['libs/checkpoint-sqlite/langgraph/store/sqlite/aio.py', 'libs/checkpoint-sqlite/langgraph/store/sqlite/__init__.py', 'libs/checkpoint-sqlite/langgraph/cache/sqlite/__init__.py']],
  ['B32', ['libs/prebuilt/langgraph/prebuilt/tool_node.py']],
  ['B33', ['libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py', 'libs/prebuilt/langgraph/prebuilt/interrupt.py']],
  ['B34', ['libs/prebuilt/langgraph/prebuilt/tool_validator.py', 'libs/prebuilt/langgraph/prebuilt/_tool_call_transformer.py', 'libs/prebuilt/langgraph/prebuilt/_tool_call_stream.py', 'libs/prebuilt/langgraph/prebuilt/__init__.py']],
];
let totalFiles = 0, totalNeed = 0, totalCode = 0;
for (const [b, files] of B) {
  let code = 0, need = 0;
  for (const f of files) {
    const x = m.get(f);
    if (!x) { console.log('MISSING', f); continue; }
    code += x.code; need += x.need;
  }
  totalFiles += files.length; totalNeed += need; totalCode += code;
  console.log(`| ${b} | ${files.length} | ${code} | ${Math.round(need * 1.05)} |`);
}
console.log('TOTAL', totalFiles, 'files, code', totalCode, 'need', totalNeed);
const all = new Set(B.flatMap((x) => x[1]));
console.log('unique files', all.size);
const scope = d.files
  .filter((f) => /^libs\/(langgraph\/langgraph|checkpoint\/langgraph|checkpoint-postgres\/langgraph|checkpoint-sqlite\/langgraph|prebuilt\/langgraph)\//.test(f.rel) && !/\/tests\//.test(f.rel) && !/\/bench\//.test(f.rel))
  .map((f) => f.rel);
console.log('uncovered:', scope.filter((r) => !all.has(r)));
