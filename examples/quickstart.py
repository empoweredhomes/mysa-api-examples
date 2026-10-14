"""Sign a Mysa customer in, list their thermostats, and read one thermostat's state.

Standard library only (Python 3.9+). Tokens stay in memory and are never printed.

    export MYSA_CLIENT_ID=<your client_id>
    python3 examples/quickstart.py
"""
import base64
import hashlib
import http.server
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

AUTH_BASE = "https://mysa-backend.mysa.cloud"
API_BASE = "https://consumer-api.mysa.cloud"
CLIENT_ID = os.environ.get("MYSA_CLIENT_ID", "")
REDIRECT_URI = os.environ.get("MYSA_REDIRECT_URI", "http://127.0.0.1:8765/callback")
SCOPE = "consumer-api/devices.read"
SIGN_IN_TIMEOUT_SECONDS = 300


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def printable(value):
    """Keeps server- or browser-supplied codes from carrying terminal escapes."""
    return re.sub(r"[^A-Za-z0-9_.-]", "?", str(value))


def without_controls(value):
    """Keeps names and ids readable but free of terminal escapes."""
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", "?", str(value))


def make_handler(redirect_path, expected_state, result):
    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 10  # an idle connection must not block the real redirect

        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            params = dict(urllib.parse.parse_qsl(url.query))
            if url.path != redirect_path:
                self.reply(404, b"Not found.")
            elif not secrets.compare_digest(params.get("state", "").encode(), expected_state.encode()):
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
            pass  # the query string holds the authorization code

    return Handler


def wait_for_redirect(redirect, expected_state):
    """Serves the loopback redirect URI until a request with the expected state arrives."""
    result = {}
    handler = make_handler(redirect.path or "/", expected_state, result)
    deadline = time.monotonic() + SIGN_IN_TIMEOUT_SECONDS
    with http.server.HTTPServer(("127.0.0.1", redirect.port), handler) as server:
        server.timeout = 1
        while not result:
            if time.monotonic() > deadline:
                sys.exit("Timed out waiting for sign-in.")
            server.handle_request()
    return result


def sign_in():
    redirect = urllib.parse.urlsplit(REDIRECT_URI)
    try:
        port = redirect.port
    except ValueError:
        port = None
    if redirect.scheme != "http" or redirect.hostname != "127.0.0.1" or not port:
        sys.exit("MYSA_REDIRECT_URI must look like http://127.0.0.1:8765/callback")

    verifier = b64url(secrets.token_bytes(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    state = b64url(secrets.token_bytes(16))

    query = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }, quote_via=urllib.parse.quote)
    print("Open this URL to sign in and approve access:\n\n  %s/oauth/authorize?%s\n" % (AUTH_BASE, query), flush=True)

    params = wait_for_redirect(redirect, state)
    if "error" in params:
        sys.exit("Sign-in failed: %s" % printable(params["error"]))
    if not params.get("code"):
        sys.exit("The redirect has no authorization code.")

    return token_request({
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": params["code"],
        "redirect_uri": REDIRECT_URI,
        "code_verifier": verifier,
    })


def token_request(form):
    request = urllib.request.Request(
        AUTH_BASE + "/oauth/token",
        data=urllib.parse.urlencode(form).encode("ascii"),
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request) as response:
            tokens = json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit("Token request failed: HTTP %d %s" % (error.code, error_code(error)))
    if not tokens.get("access_token"):
        sys.exit("The token response has no access token.")
    return tokens


def api_get(path, access_token):
    request = urllib.request.Request(API_BASE + path, headers={"Accept": "application/json"})
    # Unredirected, so a redirect cannot carry the token to another host.
    request.add_unredirected_header("Authorization", "Bearer " + access_token)
    try:
        with urllib.request.urlopen(request) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit("GET %s failed: HTTP %d %s" % (path, error.code, error_code(error)))


def error_code(error):
    try:
        return printable(json.load(error).get("error", ""))
    except (ValueError, AttributeError):
        return ""


def main():
    if not CLIENT_ID:
        sys.exit("Set MYSA_CLIENT_ID to your approved client_id.")

    tokens = sign_in()
    access_token = tokens["access_token"]
    print("Signed in. The access token expires in %s seconds.\n" % printable(tokens.get("expires_in")))

    devices = api_get("/v1/devices", access_token).get("devices", [])
    for device in devices:
        print("  ".join(without_controls(field) for field in (
            device["id"], device.get("name") or "(unnamed)", device.get("model") or "")))
    if not devices:
        print("No thermostats on this account.")
        return

    state = api_get("/v1/state/" + urllib.parse.quote(devices[0]["id"], safe=""), access_token)
    print("\nCurrent state of %s:" % without_controls(devices[0]["id"]))
    print(json.dumps(state, indent=2))


if __name__ == "__main__":
    main()
