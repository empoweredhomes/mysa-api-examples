#!/usr/bin/env bash
# Sign a Mysa customer in, list their thermostats, and read one thermostat's state.
#
# Needs bash, curl 7.76+, jq, openssl, and python3 (only to receive the
# loopback redirect). Tokens stay in shell variables, are passed to curl on
# stdin rather than the command line, and are never printed. Do not run this
# script with `bash -x`, which would print them.
#
#   export MYSA_CLIENT_ID=<your client_id>
#   bash examples/curl.sh
set -euo pipefail

AUTH_BASE="https://mysa-backend.mysa.cloud"
API_BASE="https://consumer-api.mysa.cloud"
CLIENT_ID="${MYSA_CLIENT_ID:?Set MYSA_CLIENT_ID to your approved client_id.}"
REDIRECT_URI="${MYSA_REDIRECT_URI:-http://127.0.0.1:8765/callback}"
SCOPE="consumer-api/devices.read"

if ! [[ $REDIRECT_URI =~ ^http://127\.0\.0\.1:[0-9]+/[^?#@]*$ ]]; then
  echo "MYSA_REDIRECT_URI must look like http://127.0.0.1:8765/callback" >&2
  exit 1
fi

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
urlencode() { printf '%s' "$1" | jq -sRr @uri; }
json_field() { printf '%s' "$1" | jq -r "$2"; }
# Keeps server- or browser-supplied text from carrying terminal escapes.
printable() { printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '?'; }

# 1. PKCE verifier and challenge, and a random state.
CODE_VERIFIER="$(openssl rand 32 | b64url)"
CODE_CHALLENGE="$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | b64url)"
STATE="$(openssl rand 16 | b64url)"

# 2. Send the customer to Mysa's sign-in and consent pages.
AUTHORIZE_URL="$AUTH_BASE/oauth/authorize?response_type=code&client_id=$(urlencode "$CLIENT_ID")&redirect_uri=$(urlencode "$REDIRECT_URI")&scope=$(urlencode "$SCOPE")&state=$STATE&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"
printf 'Open this URL to sign in and approve access:\n\n  %s\n\n' "$AUTHORIZE_URL"

# 3. Serve the loopback redirect URI until a request with our state arrives,
#    and print its query as JSON.
REDIRECT_QUERY="$(EXPECTED_STATE="$STATE" python3 - "$REDIRECT_URI" <<'PY'
import hmac, http.server, json, os, sys, time, urllib.parse
redirect = urllib.parse.urlsplit(sys.argv[1])
expected = os.environ["EXPECTED_STATE"].encode()
result = {}
class Handler(http.server.BaseHTTPRequestHandler):
    timeout = 10
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        params = dict(urllib.parse.parse_qsl(url.query))
        if url.path != (redirect.path or "/"):
            self.reply(404, b"Not found.")
        elif not hmac.compare_digest(params.get("state", "").encode(), expected):
            self.reply(400, b"Unexpected request.")
        else:
            result.update(params)
            self.reply(200, b"Done. You can close this tab and return to the terminal.")
    def reply(self, status, body):
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
deadline = time.monotonic() + 300
with http.server.HTTPServer(("127.0.0.1", redirect.port), Handler) as server:
    server.timeout = 1
    while not result:
        if time.monotonic() > deadline:
            sys.exit("Timed out waiting for sign-in.")
        server.handle_request()
print(json.dumps(result))
PY
)"

if [ -n "$(json_field "$REDIRECT_QUERY" '.error // ""')" ]; then
  echo "Sign-in failed: $(printable "$(json_field "$REDIRECT_QUERY" '.error')")" >&2
  exit 1
fi
CODE="$(json_field "$REDIRECT_QUERY" '.code // ""')"
if [ -z "$CODE" ]; then
  echo "The redirect has no authorization code." >&2
  exit 1
fi

# 4. Exchange the code for tokens. The form body goes to curl on stdin.
if ! TOKENS="$(printf 'grant_type=authorization_code&client_id=%s&code=%s&redirect_uri=%s&code_verifier=%s' \
    "$(urlencode "$CLIENT_ID")" "$(urlencode "$CODE")" "$(urlencode "$REDIRECT_URI")" "$CODE_VERIFIER" |
  curl -sS --fail-with-body "$AUTH_BASE/oauth/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' --data-binary @-)"; then
  echo "Token request failed: $(printable "$(json_field "$TOKENS" '.error // ""' 2>/dev/null || true)")" >&2
  exit 1
fi
ACCESS_TOKEN="$(json_field "$TOKENS" '.access_token // ""')"
if [ -z "$ACCESS_TOKEN" ]; then
  echo "The token response has no access token." >&2
  exit 1
fi
echo "Signed in. The access token expires in $(printable "$(json_field "$TOKENS" '.expires_in')") seconds."
echo

# 5. Call the API. The Authorization header goes to curl on stdin.
api_get() {
  printf 'Authorization: Bearer %s\n' "$ACCESS_TOKEN" |
    curl -sS --fail-with-body "$API_BASE$1" -H @- -H 'Accept: application/json'
}

DEVICES="$(api_get /v1/devices)"
json_field "$DEVICES" '.devices[] | "\(.id)  \(.name // "" | if . == "" then "(unnamed)" else . end)  \(.model // "")" | gsub("[\u0000-\u001f\u007f-\u009f]"; "?")'

DEVICE_ID="$(json_field "$DEVICES" '.devices[0].id // ""')"
if [ -z "$DEVICE_ID" ]; then
  echo "No thermostats on this account."
  exit 0
fi
echo
echo "Current state of $(printf '%s' "$DEVICE_ID" | tr '\000-\037\177' '?'):"
api_get "/v1/state/$(urlencode "$DEVICE_ID")" | jq .
