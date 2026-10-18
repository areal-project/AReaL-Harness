import { noise } from '@chainsafe/libp2p-noise';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey, peerIdFromString } from '@libp2p/peer-id';
import { pushable } from 'it-pushable';
import * as lp from 'it-length-prefixed';

export const base64 = bytes => btoa(String.fromCharCode(...bytes));
export const unbase64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
export async function createIdentity() { return base64(privateKeyToProtobuf(await generateKeyPair('Ed25519'))); }
export function identityId(identity) { return peerIdFromPrivateKey(privateKeyFromProtobuf(unbase64(identity))).toString(); }
export function relayUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('中继必须使用 WSS；本机开发可使用 loopback WS');
  return url.href;
}
// WSS carries only Noise records. This adapter supplies bounded iterable bytes;
// handshake, authentication, record nonces and AEAD remain owned by libp2p Noise.
export function byteChannel(write, terminate) {
  const input = pushable({ objectMode: false });
  let closed = false;
  return {
    stream: { source: input, sink: async source => { for await (const bytes of source) { if (closed) throw new Error('连接已断开'); await write(bytes.subarray()); } } },
    receive(bytes) { if (input.readableLength + bytes.length > 2 * 1024 * 1024) throw new Error('连接接收缓冲已满'); input.push(bytes); },
    close() { if (closed) return; closed = true; input.end(); terminate(); },
  };
}
export async function secureChannel(wire, identity, hostPeer) {
  const privateKey = privateKeyFromProtobuf(unbase64(identity));
  const silent = Object.assign(() => {}, { error() {}, trace() {}, enabled: false });
  const encryption = noise({ prologueBytes: new TextEncoder().encode('areal.remote.v1') })({
    privateKey, peerId: peerIdFromPrivateKey(privateKey), logger: { forComponent: () => silent },
    upgrader: { getStreamMuxers: () => new Map() },
  });
  let secured;
  try {
    const options = { signal: AbortSignal.timeout(15000), skipStreamMuxerNegotiation: true };
    secured = hostPeer
      ? await encryption.secureOutbound(wire.stream, { ...options, remotePeer: peerIdFromString(hostPeer) })
      : await encryption.secureInbound(wire.stream, options);
  } catch (error) { wire.close(); throw error; }
  const output = pushable({ objectMode: false });
  let failure;
  // libp2p's iterable sink resolves when its source is attached, not when the
  // channel closes. Only a sink error or source EOF may terminate this wire.
  const done = secured.conn.sink(lp.encode(output)).catch(error => { failure = error; wire.close(); });
  return {
    peer: secured.remotePeer.toString(), done,
    send(value) {
      const data = new TextEncoder().encode(JSON.stringify(value));
      if (data.length > 24 * 1024 * 1024 || output.readableLength + data.length > 32 * 1024 * 1024) { wire.close(); throw new Error('数据超过传输上限'); }
      output.push(data);
    },
    async *messages() {
      try {
        for await (const frame of lp.decode(secured.conn.source, { maxDataLength: 24 * 1024 * 1024 })) yield JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray()));
        if (failure) throw failure;
      }
      finally { output.end(); wire.close(); }
    },
    close() { output.end(); wire.close(); },
  };
}
