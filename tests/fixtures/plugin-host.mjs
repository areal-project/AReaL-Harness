// Adversarial protocol fixture; production example loads the real DSH package.
import { createInterface } from 'node:readline';
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
send({ protocolVersion: 1, tools: [{ name: `fixture_${mode}`, description: 'Plugin protocol fixture', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'string' } }] });
let current;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'call') {
    current = message.callId;
    if (mode === 'hang' || mode === 'timeout') continue;
    if (mode === 'environment') {
      send({ type: 'result', callId: current, response: { success: true, structuredContent: process.env.AREAL_PLUGIN_TEST_SECRET ?? 'clean', contentItems: [{ type: 'inputText', text: process.env.AREAL_PLUGIN_TEST_SECRET ?? 'clean' }] } });
      continue;
    }
    const command = mode === 'write_crash'
      ? { kind: 'write', path: 'workspace://repo/src/unknown.txt', dataBase64: Buffer.from('committed before Host crash').toString('base64'), expected: { kind: 'absent' } }
      : { kind: 'read', path: 'workspace://repo/private.txt', offset: 0, maxBytes: 100 };
    send({ type: 'file', callId: mode === 'forged' ? 'another-call' : current, requestId: 1, command });
  } else if (message.type === 'fileResult') {
    if (mode === 'write_crash') process.exit(7);
    send({ type: 'result', callId: current, response: { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(message.error) }] } });
  }
}
