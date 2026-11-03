// Live snapshot sidecar for an onvif-server bridge.
// Serves GET /snapshot.jpg on SNAP_LISTEN:SNAP_PORT by fetching the camera's
// /cgi-bin/snapshot.cgi with HTTP Digest auth. Protect never sends credentials
// to the camera through this path, so it cannot cause a Dahua login lockout.
//
// Safety: a 401 from the camera stops all fetching for AUTH_BACKOFF_MS, so a
// wrong password costs one failed login, not a lockout. Concurrent requests
// share one in-flight fetch, and a frame younger than CACHE_MS is reused.
'use strict';
const http = require('http');
const crypto = require('crypto');

const CAM = process.env.SNAP_CAMERA;            // camera IP
const USER = process.env.SNAP_USER;
const PASS = process.env.SNAP_PASS;
const LISTEN = process.env.SNAP_LISTEN || '0.0.0.0';
const PORT = parseInt(process.env.SNAP_PORT || '8580', 10);
const PATH = '/cgi-bin/snapshot.cgi?channel=1';
const CACHE_MS = 2000;
const TIMEOUT_MS = 8000;
const AUTH_BACKOFF_MS = 10 * 60 * 1000;

let last = null;          // { buf, at }
let inflight = null;
let authBlockedUntil = 0;
let nc = 0;

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function get(headers) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: CAM, port: 80, path: PATH, headers, timeout: TIMEOUT_MS }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('camera timeout')));
        req.on('error', reject);
    });
}

function digestHeader(challenge) {
    const p = {};
    challenge.replace(/(\w+)="?([^",]*)"?/g, (_, k, v) => { p[k] = v; });
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ncs = (++nc).toString(16).padStart(8, '0');
    const ha1 = md5(`${USER}:${p.realm}:${PASS}`);
    const ha2 = md5(`GET:${PATH}`);
    const qop = p.qop ? 'auth' : null;
    const response = qop ? md5(`${ha1}:${p.nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
    let h = `Digest username="${USER}", realm="${p.realm}", nonce="${p.nonce}", uri="${PATH}", response="${response}"`;
    if (qop) h += `, qop=${qop}, nc=${ncs}, cnonce="${cnonce}"`;
    if (p.opaque) h += `, opaque="${p.opaque}"`;
    return h;
}

async function fetchFrame() {
    if (Date.now() < authBlockedUntil) throw new Error('auth backoff active');
    const first = await get({});
    let res = first;
    if (first.status === 401) {
        const challenge = first.headers['www-authenticate'] || '';
        if (!/^Digest/i.test(challenge)) throw new Error('no digest challenge');
        res = await get({ Authorization: digestHeader(challenge) });
        if (res.status === 401) {
            authBlockedUntil = Date.now() + AUTH_BACKOFF_MS;
            console.error(`camera rejected credentials; pausing fetches for ${AUTH_BACKOFF_MS / 60000} min`);
            throw new Error('camera rejected credentials');
        }
    }
    if (res.status !== 200 || res.body.length < 1000 || res.body[0] !== 0xff || res.body[1] !== 0xd8)
        throw new Error(`bad camera response ${res.status} (${res.body.length} B)`);
    return res.body;
}

function frame() {
    if (last && Date.now() - last.at < CACHE_MS) return Promise.resolve(last.buf);
    if (!inflight) {
        inflight = fetchFrame()
            .then((buf) => { last = { buf, at: Date.now() }; return buf; })
            .finally(() => { inflight = null; });
    }
    return inflight;
}

http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (req.method !== 'GET' || (path !== '/snapshot.jpg' && path !== '/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('404 Not Found\n');
    }
    frame().then((buf) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
        res.end(buf);
    }).catch((err) => {
        console.error(`snapshot failed: ${err.message}`);
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end(`snapshot unavailable: ${err.message}\n`);
    });
}).listen(PORT, LISTEN, () => console.log(`snapshot sidecar for ${CAM} on ${LISTEN}:${PORT}`));
