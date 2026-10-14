/**
 * Sign a Mysa customer in, list their thermostats, and read one thermostat's state.
 *
 * Node.js 22.18+ runs this file directly; there are no dependencies. Tokens
 * stay in memory and are never printed.
 *
 *     export MYSA_CLIENT_ID=<your client_id>
 *     node examples/quickstart.ts
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const AUTH_BASE = 'https://mysa-backend.mysa.cloud';
const API_BASE = 'https://consumer-api.mysa.cloud';
const CLIENT_ID = process.env.MYSA_CLIENT_ID ?? '';
const REDIRECT_URI = process.env.MYSA_REDIRECT_URI ?? 'http://127.0.0.1:8765/callback';
const SCOPE = 'consumer-api/devices.read';
const SIGN_IN_TIMEOUT_MS = 300_000;

type Tokens = { access_token?: string; refresh_token?: string; expires_in?: number };
type Device = { id: string; name?: string; model?: string | null };

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function b64url(data: Buffer): string {
    return data.toString('base64url');
}

/** Keeps server- or browser-supplied codes from carrying terminal escapes. */
function printable(value: unknown): string {
    return String(value).replace(/[^\w.-]/g, '?');
}

/** Keeps names and ids readable but free of terminal escapes. */
function withoutControls(value: unknown): string {
    return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

function sameString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Serves the loopback redirect URI until a request with the expected state arrives. */
function waitForRedirect(redirect: URL, expectedState: string): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            const url = new URL(request.url ?? '/', redirect.origin);
            const reply = (status: number, body: string) =>
                response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(body);
            if (url.pathname !== redirect.pathname) {
                reply(404, 'Not found.');
            } else if (!sameString(url.searchParams.get('state') ?? '', expectedState)) {
                reply(400, 'Unexpected request.');
            } else {
                reply(200, 'Done. You can close this tab and return to the terminal.');
                clearTimeout(timer);
                server.close();
                resolve(url.searchParams);
            }
        });
        const timer = setTimeout(() => {
            server.close();
            reject(new Error('Timed out waiting for sign-in.'));
        }, SIGN_IN_TIMEOUT_MS);
        server.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
        server.listen(Number(redirect.port), '127.0.0.1');
    });
}

async function errorCode(response: Response): Promise<string> {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return printable(body?.error ?? '');
}

async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
    const response = await fetch(`${AUTH_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form)
    });
    if (!response.ok) {
        fail(`Token request failed: HTTP ${response.status} ${await errorCode(response)}`);
    }
    const tokens = (await response.json()) as Tokens;
    if (!tokens.access_token) {
        fail('The token response has no access token.');
    }
    return tokens;
}

async function signIn(): Promise<Tokens> {
    const redirect = URL.parse(REDIRECT_URI) ?? fail('MYSA_REDIRECT_URI is not a valid URL.');
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port) {
        fail('MYSA_REDIRECT_URI must look like http://127.0.0.1:8765/callback');
    }

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(16));

    const query = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
    });
    const redirected = waitForRedirect(redirect, state);
    console.log(`Open this URL to sign in and approve access:\n\n  ${AUTH_BASE}/oauth/authorize?${query}\n`);

    const params = await redirected.catch((error: Error) => fail(error.message));
    if (params.has('error')) {
        fail(`Sign-in failed: ${printable(params.get('error'))}`);
    }
    const code = params.get('code');
    if (!code) {
        fail('The redirect has no authorization code.');
    }

    return tokenRequest({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier
    });
}

async function apiGet<T>(path: string, accessToken: string): Promise<T> {
    // fetch drops Authorization when a redirect leads to another origin.
    const response = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!response.ok) {
        fail(`GET ${path} failed: HTTP ${response.status} ${await errorCode(response)}`);
    }
    return (await response.json()) as T;
}

if (!CLIENT_ID) {
    fail('Set MYSA_CLIENT_ID to your approved client_id.');
}

const tokens = await signIn();
const accessToken = tokens.access_token ?? '';
console.log(`Signed in. The access token expires in ${printable(tokens.expires_in)} seconds.\n`);

const { devices = [] } = await apiGet<{ devices?: Device[] }>('/v1/devices', accessToken);
for (const device of devices) {
    console.log([device.id, device.name || '(unnamed)', device.model ?? ''].map(withoutControls).join('  '));
}
if (devices.length === 0) {
    console.log('No thermostats on this account.');
} else {
    const state = await apiGet<unknown>(`/v1/state/${encodeURIComponent(devices[0].id)}`, accessToken);
    console.log(`\nCurrent state of ${withoutControls(devices[0].id)}:`);
    console.log(JSON.stringify(state, null, 2));
}
