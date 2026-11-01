// Derived from Cindy device-link-relay. Apache-2.0.
// Modified for AReaL Relay Service. See deploy/licenses/CINDY-NOTICE.
import { createPrivateKey, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { AcmeClient, AcmeNetworkError, certificateValidity, createAccountKey, LETS_ENCRYPT_DIRECTORY } from './acme.mjs';
export const STATUS_FILE = 'status.json';
const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
async function writeFileAtomically(file, content, mode) {
    await mkdir(path.dirname(file), {
        recursive: true,
        mode: 0o700
    });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(tmp, content, {
            mode,
            flag: 'wx'
        });
        await rename(tmp, file);
    } catch (error) {
        await rm(tmp, {
            force: true
        }).catch(()=>undefined);
        throw error;
    }
}
async function readOptional(file) {
    try {
        return await readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}
export class CertificateManager {
    options;
    challenges = new Map();
    now;
    directoryUrl;
    constructor(options){
        this.options = options;
        this.now = options.now ?? Date.now;
        this.directoryUrl = options.directoryUrl ?? LETS_ENCRYPT_DIRECTORY;
    }
    file(...parts) {
        return path.join(this.options.dataDir, ...parts);
    }
    async load() {
        const materialText = await readOptional(this.file('tls', 'material.json'));
        try {
            if (materialText === null) return null;
            const { cert, key, ...meta } = JSON.parse(materialText);
            if (meta.identifier?.type !== this.options.identifier.type || meta.identifier.value !== this.options.identifier.value) {
                return null;
            }
            if (!this.matches(cert, key)) return null;
            const validity = certificateValidity(cert);
            if (validity.notAfter <= this.now() || validity.notBefore > this.now()) return null;
            return {
                cert,
                key,
                ...validity
            };
        } catch  {
            return null;
        }
    }
    matches(cert, key) {
        const certificate = new X509Certificate(cert);
        const { type, value } = this.options.identifier;
        return certificate.checkPrivateKey(createPrivateKey(key)) && Boolean(type === 'ip'
            ? certificate.checkIP(value) : certificate.checkHost(value, { subject: 'never' }));
    }
    needsRenewal(material) {
        const lifetime = material.notAfter - material.notBefore;
        return material.notAfter - this.now() < lifetime / 3;
    }
    async obtain() {
        await this.writeStatus('requesting');
        try {
            const issued = await this.issue();
            if (!this.matches(issued.certPem, issued.keyPem) || issued.notBefore > this.now() || issued.notAfter <= this.now()) {
                throw new Error('certificate identity or validity does not match the requested TLS identity');
            }
            this.options.signal?.throwIfAborted();
            await writeFileAtomically(this.file('tls', 'material.json'), JSON.stringify({
                cert: issued.certPem,
                key: issued.keyPem,
                identifier: this.options.identifier
            }), 0o600);
            await this.writeStatus('ready', {
                notAfter: new Date(issued.notAfter).toISOString()
            });
            this.options.logger.info('certificate issued', {
                notAfter: new Date(issued.notAfter).toISOString()
            });
            return {
                cert: issued.certPem,
                key: issued.keyPem,
                notBefore: issued.notBefore,
                notAfter: issued.notAfter
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            const transient = error instanceof AcmeNetworkError;
            await this.writeStatus('failed', {
                error: message.slice(0, 500),
                ...transient ? {
                    transient
                } : {}
            });
            this.options.logger.error('certificate request failed', {
                reason: message.slice(0, 500),
                transient
            });
            throw error;
        }
    }
    async issue() {
        const keyFile = this.file('acme', 'account-key.pem');
        const accountFile = this.file('acme', 'account.json');
        let keyPem = await readOptional(keyFile);
        if (!keyPem) {
            keyPem = createAccountKey().export({
                type: 'pkcs8',
                format: 'pem'
            });
            await writeFileAtomically(keyFile, keyPem, 0o600);
        }
        let accountUrl = null;
        try {
            const saved = JSON.parse(await readOptional(accountFile) ?? '{}');
            if (saved.directoryUrl === this.directoryUrl && typeof saved.accountUrl === 'string') accountUrl = saved.accountUrl;
        } catch  {
            accountUrl = null;
        }
        const client = new AcmeClient({
            directoryUrl: this.directoryUrl,
            accountKey: createPrivateKey(keyPem),
            accountUrl,
            fetchImpl: this.options.fetchImpl,
            signal: this.options.signal,
            log: (message)=>this.options.logger.info(message)
        });
        try {
            return await client.obtainCertificate(this.options.identifier, this.challenges);
        } finally{
            if (client.accountUrl && client.accountUrl !== accountUrl) {
                await writeFileAtomically(accountFile, JSON.stringify({
                    directoryUrl: this.directoryUrl,
                    accountUrl: client.accountUrl
                }), 0o600);
            }
        }
    }
    async writeStatus(state, extra = {}) {
        const status = {
            certificate: {
                state,
                identifier: this.options.identifier.value,
                ...extra,
                updatedAt: new Date(this.now()).toISOString()
            }
        };
        await writeFileAtomically(this.file(STATUS_FILE), JSON.stringify(status), 0o600).catch(()=>undefined);
    }
}
export async function startChallengeServer(options) {
    const server = createServer((req, res)=>{
        let pathname;
        try {
            pathname = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
        } catch  {
            res.writeHead(400, {
                'Connection': 'close',
                'Content-Type': 'text/plain'
            });
            res.end('Invalid request target.\n');
            return;
        }
        if (req.method === 'GET' && pathname.startsWith(CHALLENGE_PREFIX)) {
            const answer = options.challenges.get(pathname.slice(CHALLENGE_PREFIX.length));
            if (answer) {
                res.writeHead(200, {
                    'Content-Type': 'text/plain',
                    'Content-Length': String(Buffer.byteLength(answer))
                });
                res.end(answer);
                return;
            }
        }
        res.writeHead(404, {
            'Content-Type': 'text/plain'
        });
        res.end('This is an AReaL relay. Use https.\n');
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    await new Promise((resolve, reject)=>{
        server.once('error', reject);
        server.listen(options.port, options.host, ()=>{
            server.off('error', reject);
            resolve();
        });
    });
    return {
        port: server.address().port,
        close: ()=>new Promise((resolve)=>{
                server.close(()=>resolve());
                server.closeAllConnections?.();
            })
    };
}
