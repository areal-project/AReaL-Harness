import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';

const log = value => appendFileSync(process.argv[2], `${JSON.stringify({ at: Date.now(), ...value })}\n`);
const pending = new Map();
let next = 1000, value = 0, cleanupFailure = false;
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: typeof value === 'object' ? value : { value } });
const instructionFile = join(dirname(process.argv[2]), 'instruction-bytes');
const instructions = existsSync(instructionFile) ? 'I'.repeat(Number(readFileSync(instructionFile, 'utf8'))) : 'ORIGINAL CUA INSTRUCTIONS\n' + 'Complete runtime instruction. '.repeat(400) + '\nORIGINAL INSTRUCTIONS END';
const tools = [
  { name: 'js', description: 'Original fixture JavaScript tool', inputSchema: { type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['code'], additionalProperties: false }, outputSchema: { type: 'object', additionalProperties: true }, annotations: { readOnlyHint: false } },
  { name: 'js_reset', description: 'Original fixture reset', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'turn_ended', description: 'Host only', inputSchema: { type: 'object' } },
];
log({ type: 'start', pid: process.pid, surfaces: process.env.CUA_REPL_ENABLED_SURFACES, inheritedBypass: process.env.LCU_ALLOW_AGENT_HOST_APPROVAL });
const server = process.env.LCU_MAC_CONTROL_SOCKET && createServer(socket => {
  let data = '';
  socket.on('data', chunk => {
    data += chunk;
    if (!data.includes('\n')) return;
    const request = JSON.parse(data.trim());
    log({ type: 'control', request });
    socket.end(JSON.stringify({ ok: true, result: request.type === 'status'
      ? { computerUse: { activeApplications: [{ applicationId: 'fixture.app', name: 'Fixture' }] } }
      : { accepted: true, applicationId: request.app } }) + '\n');
  });
});
if (server) await new Promise(resolve => server.listen(process.env.LCU_MAC_CONTROL_SOCKET, resolve));
createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (!request.method) { pending.get(request.id)?.(request.result); pending.delete(request.id); return; }
  if (request.id === undefined) return;
  log({ type: 'request', ...request });
  const reply = result => send({ id: request.id, result });
  if (request.method === 'initialize' && existsSync(join(dirname(process.argv[2]), 'block-connect'))) {
    while (!existsSync(join(dirname(process.argv[2]), 'release-connect'))) await new Promise(resolve => setTimeout(resolve, 10));
  }
  if (request.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} }, instructions });
  if (request.method === 'tools/list') return reply({ tools });
  if (request.method !== 'tools/call') return send({ id: request.id, error: { code: -32601, message: 'Unsupported' } });
  const { name, arguments: args } = request.params;
  if (name === 'turn_ended') return reply(cleanupFailure ? { ...text('turn-ended handlers timed out'), isError: true } : text({ ended: args }));
  if (name === 'js_reset') { value = 0; return reply(text({ reset: true })); }
  if (args.code === 'cleanup-failure') { cleanupFailure = true; return reply(text({ armed: true })); }
  if (args.code === 'crash') { log({ type: 'effect', value: ++value }); process.exit(7); }
  if (args.code === 'wait') return;
  if (['approval', 'approval-host'].includes(args.code) || args.code.startsWith('approval-app:')) {
    const id = next++;
    const answer = new Promise(resolve => pending.set(id, resolve));
    send({ id, method: 'elicitation/create', params: { mode: 'form', message: 'Allow Fixture to control this app?', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', tool_params: { app: args.code.startsWith('approval-app:') ? args.code.slice('approval-app:'.length) : args.code === 'approval-host' ? 'com.openai.codex' : 'fixture.app' }, persist: ['session', 'always'] } } });
    return reply(text({ approval: await answer }));
  }
  if (args.code === 'image') return reply({ content: [{ type: 'text', text: 'Original image ' + 'x'.repeat(20000) + ' MIXED_RESULT_END' }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFOsAAAAASUVORK5CYII=' }], structuredContent: { original: true } });
  if (args.code === 'error') return reply({ ...text({ knownFailure: true }), isError: true });
  reply(text({ value: ++value, metadata: request.params._meta }));
}).on('close', () => { server?.close(); process.exit(0); });
