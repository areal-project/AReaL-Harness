// Derived from Cindy device-link-relay. Apache-2.0.
// Modified for AReaL Relay Service. See deploy/licenses/CINDY-NOTICE.
import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCsr } from './csr.mjs';
export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
const VALIDATION_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const NETWORK_RETRY_DELAYS_MS = [
    2_000,
    5_000
];
export class AcmeError extends Error {
    constructor(message){
        super(message);
        this.name = 'AcmeError';
    }
}
export class AcmeNetworkError extends AcmeError {
    transient = true;
    constructor(message){
        super(message);
        this.name = 'AcmeNetworkError';
    }
}
function networkFailureReason(error) {
    if (error instanceof AcmeError || !(error instanceof Error)) return null;
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timed out';
    if (!(error instanceof TypeError)) return null;
    const cause = error.cause;
    const reason = typeof cause?.code === 'string' ? cause.code : typeof cause?.message === 'string' ? cause.message : error.message;
    return reason.slice(0, 80);
}
function b64url(data) {
    return Buffer.from(data).toString('base64url');
}
function problem(body, fallback) {
    if (!body) return fallback;
    const subproblems = Array.isArray(body.subproblems) ? body.subproblems.map((p)=>p.detail).filter(Boolean).join('; ') : '';
    return [
        body.type,
        body.detail,
        subproblems
    ].filter(Boolean).join(': ') || fallback;
}
export function firstCertificate(pemChain) {
    const match = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pemChain);
    if (!match) throw new AcmeError('the CA returned no certificate');
    return match[0];
}
export function certificateValidity(pemChain) {
    const cert = new X509Certificate(firstCertificate(pemChain));
    return {
        notBefore: Date.parse(cert.validFrom),
        notAfter: Date.parse(cert.validTo)
    };
}
export function createAccountKey() {
    return generateKeyPairSync('ec', {
        namedCurve: 'P-256'
    }).privateKey;
}
export class AcmeClient {
    options;
    fetchImpl;
    sleep;
    log;
    jwk;
    directory = null;
    nonce = null;
    kid;
    constructor(options){
        this.options = options;
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.sleep = options.sleep ?? ((ms) => delay(ms, undefined, { signal: options.signal }));
        this.log = options.log ?? (()=>undefined);
        const jwk = options.accountKey.export({
            format: 'jwk'
        });
        this.jwk = {
            crv: jwk.crv,
            kty: jwk.kty,
            x: jwk.x,
            y: jwk.y
        };
        this.kid = options.accountUrl ?? null;
    }
    get accountUrl() {
        return this.kid;
    }
    get thumbprint() {
        const { crv, kty, x, y } = this.jwk;
        return b64url(createHash('sha256').update(JSON.stringify({
            crv,
            kty,
            x,
            y
        })).digest());
    }
    async send(url, init = {}) {
        for(let attempt = 0;; attempt++){
            let reason;
            try {
                const res = await this.fetchImpl(url, {
                    ...init,
                    signal: this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
                const text = init.method === 'HEAD' ? '' : await res.text();
                if (res.status < 500) return {
                    res,
                    text
                };
                reason = `HTTP ${res.status}`;
            } catch (error) {
                this.options.signal?.throwIfAborted();
                const failure = networkFailureReason(error);
                if (!failure) throw error;
                reason = failure;
            }
            if (attempt >= NETWORK_RETRY_DELAYS_MS.length) {
                throw new AcmeNetworkError(`could not reach the certificate authority (${reason})`);
            }
            this.log(`certificate authority unreachable (${reason}), retrying`);
            await this.sleep(NETWORK_RETRY_DELAYS_MS[attempt]);
        }
    }
    async getDirectory() {
        if (this.directory) return this.directory;
        const { res, text } = await this.send(this.options.directoryUrl);
        let body = null;
        try {
            body = JSON.parse(text);
        } catch  {
            body = null;
        }
        if (!res.ok || !body?.newNonce || !body.newAccount || !body.newOrder) {
            throw new AcmeError(`certificate authority directory unavailable (${res.status})`);
        }
        this.directory = body;
        return body;
    }
    async getNonce() {
        if (this.nonce) {
            const nonce = this.nonce;
            this.nonce = null;
            return nonce;
        }
        const { res } = await this.send((await this.getDirectory()).newNonce, {
            method: 'HEAD'
        });
        const nonce = res.headers.get('replay-nonce');
        if (!nonce) throw new AcmeError('certificate authority returned no nonce');
        return nonce;
    }
    async post(url, payload, options = {}) {
        for(let attempt = 0; attempt < 3; attempt++){
            const header = {
                alg: 'ES256',
                nonce: await this.getNonce(),
                url,
                ...options.useJwk || !this.kid ? {
                    jwk: this.jwk
                } : {
                    kid: this.kid
                }
            };
            const protectedPart = b64url(JSON.stringify(header));
            const payloadPart = payload === undefined ? '' : b64url(JSON.stringify(payload));
            const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), {
                key: this.options.accountKey,
                dsaEncoding: 'ieee-p1363'
            });
            const { res, text } = await this.send(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/jose+json',
                    ...options.accept ? {
                        Accept: options.accept
                    } : {}
                },
                body: JSON.stringify({
                    protected: protectedPart,
                    payload: payloadPart,
                    signature: b64url(signature)
                })
            });
            this.nonce = res.headers.get('replay-nonce');
            let body = null;
            try {
                body = JSON.parse(text);
            } catch  {
                body = null;
            }
            if (res.status === 400 && body?.type === 'urn:ietf:params:acme:error:badNonce') continue;
            return {
                status: res.status,
                headers: res.headers,
                body,
                text
            };
        }
        throw new AcmeError('certificate authority kept rejecting nonces');
    }
    async ensureAccount() {
        if (this.kid) return;
        const directory = await this.getDirectory();
        const res = await this.post(directory.newAccount, {
            termsOfServiceAgreed: true
        }, {
            useJwk: true
        });
        const location = res.headers.get('location');
        if (res.status !== 200 && res.status !== 201 || !location) {
            throw new AcmeError(`account registration failed: ${problem(res.body, String(res.status))}`);
        }
        this.kid = location;
    }
    async pollUntil(url, done, what) {
        const deadline = Date.now() + VALIDATION_TIMEOUT_MS;
        for(;;){
            const res = await this.post(url, undefined);
            if (res.status >= 400 || !res.body) throw new AcmeError(`${what} failed: ${problem(res.body, String(res.status))}`);
            if (res.body.status === 'invalid') {
                const failed = Array.isArray(res.body.challenges) ? res.body.challenges.find((c)=>c.error)?.error : res.body.error;
                throw new AcmeError(`${what} failed: ${problem(failed ?? null, 'invalid')}`);
            }
            if (done(res.body)) return res.body;
            if (Date.now() > deadline) throw new AcmeError(`${what} timed out`);
            const retryAfter = Number(res.headers.get('retry-after'));
            await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : POLL_INTERVAL_MS);
        }
    }
    async obtainCertificate(identifier, challenges) {
        const directory = await this.getDirectory();
        await this.ensureAccount();
        const profiles = directory.meta?.profiles ?? {};
        const profile = identifier.type === 'ip' && 'shortlived' in profiles ? 'shortlived' : undefined;
        this.log(`requesting a certificate for ${identifier.type} ${identifier.value}${profile ? ` (profile ${profile})` : ''}`);
        const order = await this.post(directory.newOrder, {
            identifiers: [
                identifier
            ],
            ...profile ? {
                profile
            } : {}
        });
        const orderUrl = order.headers.get('location');
        if (order.status !== 201 || !order.body || !orderUrl) {
            throw new AcmeError(`order failed: ${problem(order.body, String(order.status))}`);
        }
        for (const authzUrl of order.body.authorizations){
            const authz = await this.post(authzUrl, undefined);
            if (authz.body?.status === 'valid') continue;
            const challenge = authz.body?.challenges?.find((c)=>c.type === 'http-01');
            if (!challenge) throw new AcmeError('the certificate authority offered no http-01 validation');
            challenges.set(challenge.token, `${challenge.token}.${this.thumbprint}`);
            try {
                const triggered = await this.post(challenge.url, {});
                if (triggered.status >= 400) throw new AcmeError(`validation failed: ${problem(triggered.body, String(triggered.status))}`);
                await this.pollUntil(authzUrl, (body)=>body.status === 'valid', 'validation');
            } finally{
                challenges.delete(challenge.token);
            }
        }
        await this.pollUntil(orderUrl, (body)=>body.status === 'ready' || body.status === 'valid', 'order');
        const certKey = generateKeyPairSync('ec', {
            namedCurve: 'P-256'
        }).privateKey;
        const finalized = await this.post(order.body.finalize, {
            csr: b64url(buildCsr(certKey, identifier))
        });
        if (finalized.status >= 400) throw new AcmeError(`finalize failed: ${problem(finalized.body, String(finalized.status))}`);
        const ready = await this.pollUntil(orderUrl, (body)=>body.status === 'valid' && Boolean(body.certificate), 'issuance');
        const download = await this.post(ready.certificate, undefined, {
            accept: 'application/pem-certificate-chain'
        });
        if (download.status !== 200 || !download.text.includes('BEGIN CERTIFICATE')) {
            throw new AcmeError(`certificate download failed (${download.status})`);
        }
        const certPem = download.text;
        return {
            certPem,
            keyPem: certKey.export({
                type: 'pkcs8',
                format: 'pem'
            }),
            ...certificateValidity(certPem)
        };
    }
}
