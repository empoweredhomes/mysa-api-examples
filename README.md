# Mysa Consumer API: getting started

The Mysa Consumer API lets an app read and control the Mysa thermostats a
customer can access, including ones shared with them, after the customer signs
in with Mysa and approves access. This
repository is the starting point: a short guide to the flow, and small examples
in [curl](examples/curl.sh), [Python](examples/quickstart.py) and
[TypeScript](examples/quickstart.ts).

The full API reference is published by the API itself:

- Reference: <https://consumer-api.mysa.cloud/v1/reference>
- OpenAPI document: <https://consumer-api.mysa.cloud/v1/openapi.json>
- Agent tool catalogue (MCP): <https://consumer-api.mysa.cloud/v1/agents>

What Mysa tells customers about connecting an app is at
<https://consumer-api.mysa.cloud/v1/terms>. It is not an agreement with
developers.

The API calls a thermostat a device.

## 1. Get a client

An app needs Mysa's approval before it can receive tokens. There is no
self-serve registration. Email [support@getmysa.com](mailto:support@getmysa.com)
with:

- your app's name, and the person or company that publishes it;
- what it does with a customer's thermostats;
- every redirect URI it will use, exactly as it will send them. Mysa matches
  redirect URIs exactly, including the port, so a loopback URI (an
  `http://127.0.0.1:<port>/...` address, for an app that runs on the
  customer's own computer) must include the port it will listen on. To run the
  examples in this repository, include `http://127.0.0.1:8765/callback`; and
- the scopes it needs (see [Scopes](#3-scopes)). The examples need only
  `consumer-api/devices.read`.

Approval is at Mysa's discretion, and Mysa can revoke a client. An approved app
receives a `client_id`. The `client_id` is public. There is no client secret:
sign-in is proven with PKCE. Use of the API is governed by the terms of Mysa's
written approval.

## 2. Hosts

Sign-in and the API are on different hosts. Do not send a customer to
`/oauth/authorize` on the API host.

| Purpose | Base URL |
| --- | --- |
| Sign-in and tokens (`/oauth/authorize`, `/oauth/token`) | `https://mysa-backend.mysa.cloud` |
| API (`/v1/...`) | `https://consumer-api.mysa.cloud` |

The sign-in host publishes its metadata at
<https://mysa-backend.mysa.cloud/.well-known/oauth-authorization-server>.

## 3. Scopes

Request only what your app needs, space-separated. A scope your client is not
approved for sends the customer back to your redirect URI with
`error=invalid_scope`. The customer approves the whole set your app asks for.

| Scope | Allows |
| --- | --- |
| `consumer-api/devices.read` | list thermostats, capabilities, current state |
| `consumer-api/devices.control` | mode, setpoints, fan, swing, keypad lockout, display brightness |
| `consumer-api/schedules.read` | read schedules |
| `consumer-api/schedules.write` | hold, follow the schedule, and create, replace or delete schedule programs |
| `consumer-api/energy.read` | energy and temperature history |

## 4. Sign the customer in

The API uses the OAuth 2.0 authorization code flow with PKCE (`S256`).

1. For every sign-in, make a new random `code_verifier` (43 to 128 characters
   from `A-Z a-z 0-9 - . _ ~`), its `code_challenge` (base64url of the SHA-256
   of the verifier, without padding), and a new random `state`.
2. Send the customer's browser (the system browser, not an embedded web view)
   to:

   ```text
   https://mysa-backend.mysa.cloud/oauth/authorize
     ?response_type=code
     &client_id=<your client_id>
     &redirect_uri=<a registered redirect URI>
     &scope=consumer-api/devices.read
     &state=<state>
     &code_challenge=<code_challenge>
     &code_challenge_method=S256
   ```

   The customer signs in on Mysa's page and approves access on Mysa's consent
   page. Your app never sees their password.
3. Mysa redirects to your `redirect_uri` with `code` and `state`, or with
   `error` if the customer chose **Deny** or the request was refused. Check
   that `state` matches before using anything else in the redirect. Some
   failures, such as an unregistered redirect URI, stay on a Mysa error page
   and never reach your app.
4. Within 60 seconds, exchange the code. The body must be form-encoded, and
   `client_id` goes in the body (there is no HTTP Basic authentication):

   ```bash
   printf '%s' "$CODE_VERIFIER" | curl -sS https://mysa-backend.mysa.cloud/oauth/token \
     -d grant_type=authorization_code \
     --data-urlencode client_id="$MYSA_CLIENT_ID" \
     --data-urlencode code="$CODE" \
     --data-urlencode redirect_uri="$MYSA_REDIRECT_URI" \
     --data-urlencode code_verifier@-
   ```

   The response has `access_token`, `refresh_token`, `token_type` and
   `expires_in`. An access token lasts 60 minutes.
5. Before `expires_in` runs out, refresh:

   ```bash
   printf '%s' "$REFRESH_TOKEN" | curl -sS https://mysa-backend.mysa.cloud/oauth/token \
     -d grant_type=refresh_token \
     --data-urlencode client_id="$MYSA_CLIENT_ID" \
     --data-urlencode refresh_token@-
   ```

   A refresh response does not include a new refresh token, so keep the one
   you have. A refresh token stops working 30 days after the sign-in that
   issued it (refreshing does not extend this), as soon as the same customer
   approves your app again (only the newest refresh token works), or sooner if
   the customer disconnects the app or Mysa revokes your client. When a refresh
   fails with `invalid_grant`, send the customer through sign-in again.

Use `https` redirect URIs; `http` is accepted only for `localhost`,
`127.0.0.1` and `::1`.

### Keeping tokens safe

A refresh token keeps working for up to 30 days, so treat it, and every access
token, as a password:

- Keep refresh tokens on your server, encrypted at rest, or in the operating
  system's keychain or keystore on a device. Never send them to a browser or
  put them in local storage.
- Never log tokens or put them in a URL, crash report, analytics event or
  commit.
- Never disable TLS certificate verification.
- When a customer signs out of your app, delete the tokens you hold for them.
  If a token leaks, tell [support@getmysa.com](mailto:support@getmysa.com) so
  Mysa can revoke it.

## 5. Call the API

Send the access token as a bearer token. The examples here pass it to curl on
stdin so it does not appear in the process list:

```bash
printf 'Authorization: Bearer %s\n' "$ACCESS_TOKEN" |
  curl -sS https://consumer-api.mysa.cloud/v1/devices -H @-

DEVICE_ID=<an id from GET /v1/devices>
printf 'Authorization: Bearer %s\n' "$ACCESS_TOKEN" |
  curl -sS "https://consumer-api.mysa.cloud/v1/state/$DEVICE_ID" -H @-
```

`GET /v1/devices` returns up to `limit` devices (default 100, at most 200)
starting at `offset`, with `total`, and `nextOffset` when there are more.

Changing a thermostat needs `consumer-api/devices.control`. A setpoint is in
degrees Celsius and must be one of the values
`GET /v1/capabilities/{deviceId}` lists for that mode; a value between two
steps is rejected with `400 invalid_request`, not rounded. Setting a heat
setpoint also switches the thermostat to heat mode.

```bash
printf 'Authorization: Bearer %s\n' "$ACCESS_TOKEN" |
  curl -sS -X PUT "https://consumer-api.mysa.cloud/v1/state/$DEVICE_ID/setpoints/heat" \
    -H @- -H "Content-Type: application/json" \
    -d '{"setpoint": 20}'
```

Control and hold calls return `204` once the change is accepted; the
thermostat applies it shortly after. Creating a schedule program returns `201`,
and replacing one returns `200`.

These calls act on real heating and cooling equipment in someone's home.
Confirm the customer's intent before changing anything, do not automate rapid
changes, and test against your own account and devices.

### Errors and limits

Errors have a fixed body, `{"error": "<code>"}`.

| Status | `error` | What to do |
| --- | --- | --- |
| `400` | `invalid_request` | fix the request: send only documented fields and listed values |
| `401` | `unauthorized` | refresh and retry once; sign the customer in again only if the refresh returns `invalid_grant` |
| `403` | `insufficient_scope` | the token lacks the scope this operation needs (request it, and have the customer approve again), or the path or method is not a `/v1` operation |
| `404` | `not_found` | the device or schedule does not exist or is not available to this customer |
| `429` | `too_many_requests` | wait at least `Retry-After` seconds before retrying |
| `500` | `server_error` | retry later, with backoff |
| `503` | `temporarily_unavailable` | wait at least `Retry-After` seconds before retrying |

Requests are limited per app and per customer, and writes more tightly than
reads. Design for `429` rather than for a particular number.

Ignore response fields you do not recognize: new fields can appear within
`/v1`. Request bodies are strict: send only the documented fields.

## Run the examples

Each example signs in with a loopback redirect, lists the customer's
thermostats, and reads the current state of the first one. It only reads; it
changes nothing. Tokens are kept in memory and never printed.

Your client must be approved with the redirect URI
`http://127.0.0.1:8765/callback` and the scope `consumer-api/devices.read`.
From a clone of this repository, set your `client_id`:

```bash
export MYSA_CLIENT_ID=<your client_id>
```

Then run one:

```bash
bash examples/curl.sh            # bash, curl 7.76+, jq, openssl, python3
python3 examples/quickstart.py   # Python 3.9+, standard library only
node examples/quickstart.ts      # Node.js 22.18+, no dependencies
```

On Windows, run the Python or Node example from PowerShell after
`$env:MYSA_CLIENT_ID = "<your client_id>"` (use `python` in place of
`python3`). `curl.sh` needs bash, for example from WSL or Git Bash.

Each prints a sign-in URL. Open it, sign in, and choose **Allow**. The browser
tab then says "Done", and the terminal shows:

```text
Signed in. The access token expires in <seconds> seconds.

<device id>  <name>  <model>

Current state of <device id>:
{ ...the GET /v1/state response... }
```

To build on them, request the scopes your app needs and refresh tokens as in
step 4.

## Use with an AI assistant (MCP)

The API also serves a Model Context Protocol endpoint:

```text
https://consumer-api.mysa.cloud/v1/mcp
```

An MCP client finds Mysa's sign-in from that URL and sends the customer
through the same Mysa sign-in and consent. Mysa does not support dynamic client
registration, so the MCP client must be configured with its own approved
`client_id` and a registered redirect URI, and Mysa must enable MCP for that
client. Requests from a web page (with an `Origin` header) are refused. The
tools are listed at <https://consumer-api.mysa.cloud/v1/agents>.

## Customers

A customer can disconnect an app by contacting Mysa support at
[support@getmysa.com](mailto:support@getmysa.com). From then on, the app's
access and refresh tokens are refused.

## Support

For questions about access or the API, email
[support@getmysa.com](mailto:support@getmysa.com). This repository does not
accept issues or pull requests.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

Copyright 2026 Empowered Homes Inc.

The examples are licensed under the [Apache License 2.0](LICENSE). They are
examples, not an SDK, and are provided "as is", without warranties or
conditions of any kind. The licence covers this code only. It does not grant
access to the Mysa Consumer API; that access is governed by the terms of
Mysa's written approval.

Mysa is a trademark of Empowered Homes Inc. The Apache License does not grant
permission to use it.
