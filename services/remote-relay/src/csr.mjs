// Derived from Cindy device-link-relay. Apache-2.0.
// Modified for AReaL Relay Service. See deploy/licenses/CINDY-NOTICE.
import { createPublicKey, sign } from 'node:crypto';
import { isIP, isIPv4, isIPv6 } from 'node:net';
export function identifierFor(address) {
    return isIP(address) ? {
        type: 'ip',
        value: address
    } : {
        type: 'dns',
        value: address.toLowerCase()
    };
}
function encodeLength(length) {
    if (length < 0x80) return Buffer.from([
        length
    ]);
    const bytes = [];
    for(let n = length; n > 0; n >>= 8)bytes.unshift(n & 0xff);
    return Buffer.from([
        0x80 | bytes.length,
        ...bytes
    ]);
}
function tlv(tag, ...parts) {
    const content = Buffer.concat(parts);
    return Buffer.concat([
        Buffer.from([
            tag
        ]),
        encodeLength(content.length),
        content
    ]);
}
const sequence = (...parts)=>tlv(0x30, ...parts);
const set = (...parts)=>tlv(0x31, ...parts);
function objectId(dotted) {
    const [first, second, ...rest] = dotted.split('.').map(Number);
    const bytes = [
        first * 40 + second
    ];
    for (const value of rest){
        const chunk = [
            value & 0x7f
        ];
        for(let n = value >> 7; n > 0; n >>= 7)chunk.unshift(0x80 | n & 0x7f);
        bytes.push(...chunk);
    }
    return tlv(0x06, Buffer.from(bytes));
}
function ipBytes(address) {
    if (isIPv4(address)) return Buffer.from(address.split('.').map(Number));
    if (!isIPv6(address)) throw new Error('invalid IP address');
    const lastColon = address.lastIndexOf(':');
    const ipv4Tail = address.slice(lastColon + 1);
    if (isIPv4(ipv4Tail)) {
        const bytes = Buffer.from(ipv4Tail.split('.').map(Number));
        address = `${address.slice(0, lastColon + 1)}${bytes.readUInt16BE(0).toString(16)}:${bytes.readUInt16BE(2).toString(16)}`;
    }
    const [head, tail] = address.includes('::') ? address.split('::') : [
        address,
        undefined
    ];
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const missing = 8 - headParts.length - tailParts.length;
    const groups = [
        ...headParts,
        ...Array(tail === undefined ? 0 : missing).fill('0'),
        ...tailParts
    ];
    const out = Buffer.alloc(16);
    groups.forEach((group, index)=>out.writeUInt16BE(parseInt(group || '0', 16), index * 2));
    return out;
}
const OID_COMMON_NAME = '2.5.4.3';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
export function buildCsr(privateKey, identifier) {
    const spki = createPublicKey(privateKey).export({
        type: 'spki',
        format: 'der'
    });
    const subject = identifier.type === 'dns' ? sequence(set(sequence(objectId(OID_COMMON_NAME), tlv(0x0c, Buffer.from(identifier.value, 'utf8'))))) : sequence();
    const generalName = identifier.type === 'ip' ? tlv(0x87, ipBytes(identifier.value)) : tlv(0x82, Buffer.from(identifier.value, 'ascii'));
    const subjectAltName = sequence(objectId(OID_SUBJECT_ALT_NAME), tlv(0x04, sequence(generalName)));
    const extensionRequest = sequence(objectId(OID_EXTENSION_REQUEST), set(sequence(subjectAltName)));
    const info = sequence(tlv(0x02, Buffer.from([
        0
    ])), subject, spki, tlv(0xa0, extensionRequest));
    const signature = sign('sha256', info, privateKey);
    return sequence(info, sequence(objectId(OID_ECDSA_WITH_SHA256)), tlv(0x03, Buffer.from([
        0
    ]), signature));
}
