import fs from 'fs';
const L = fs.readFileSync('d:/code/opensource/langgraph/libs/langgraph/langgraph/pregel/_algo.py', 'utf8').split(/\r?\n/);
const targets = [
  'if for_execution:',
  'writes: deque[tuple[str, Any]] = deque()',
  'scratchpad = _scratchpad(',
  'runtime = cast(',
  'metadata = {',
  'additional_config = {',
  'additional_config: RunnableConfig = {',
  'CONFIG_KEY_SEND: writes.extend,',
  'CONFIG_KEY_READ: partial(',
  'CONFIG_KEY_CHECKPOINT_ID: None,',
  'logger.warning(',
  'if proc.metadata:',
  'run_name=packet.node,',
  'run_name=handler_node_name,',
  'task_id = task_id_func(',
  'stop=stop,',
  '"langgraph_triggers": triggers,',
];
for (const x of targets) {
  const idx = [];
  L.forEach((l, i) => { if (l.trim() === x) idx.push(i + 1); });
  console.log(x, '=>', idx.join(','));
}
