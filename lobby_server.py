#!/usr/bin/env python3
"""
Public lobby list for the baseball game. Python 3.8+, standard library only (no installs).

Hosts tell it "I'm hosting" every few seconds; players ask it "who is hosting?".
It does NOT carry any game traffic - players still connect straight to the host.

Run locally to test:     python3 lobby_server.py          (listens on port 8080)
On Render (free):        Start command  python lobby_server.py
                         Environment    TRUST_PROXY = 1
Then put the public address in network.gd:  const LOBBY_SERVER_URL := "https://your-name.onrender.com"
"""
import ipaddress, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "8080"))      # hosting sites set PORT for you
TRUST_PROXY = os.environ.get("TRUST_PROXY", "") == "1"   # ONLY set this when running behind a host's proxy (Render etc.)
TTL = 20.0               # a lobby disappears this many seconds after its host stopped checking in
MAX_PER_IP = 3           # lobbies one address may list
MAX_TOTAL = 500
MAX_BODY = 2048

lock = threading.Lock()
lobbies = {}             # "ip:port" -> dict


def clean_str(v, n):
    return "".join(ch for ch in str(v) if ch.isprintable())[:n]


def clean_int(v, lo, hi, default):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return default


def prune(now):
    for k in [k for k, v in lobbies.items() if now - v["_t"] > TTL]:
        del lobbies[k]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _client_ip(self):
        if TRUST_PROXY:
            xff = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            try:
                if ipaddress.ip_address(xff).is_global:      # ignore garbage / private addresses
                    return xff
            except ValueError:
                pass
        return self.client_address[0]

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/health"):
            return self._send(200, {"ok": True})
        if u.path != "/lobbies":
            return self._send(404, {"error": "not found"})
        want = parse_qs(u.query).get("v", [""])[0]
        now = time.time()
        with lock:
            prune(now)
            out = [{k: v for k, v in l.items() if not k.startswith("_")}
                   for l in lobbies.values() if l["version"] == want][:100]
        self._send(200, out)

    def do_POST(self):
        if urlparse(self.path).path != "/lobby":
            return self._send(404, {"error": "not found"})
        n = clean_int(self.headers.get("Content-Length", "0"), 0, 10**9, 0)
        if n <= 0 or n > MAX_BODY:
            return self._send(400, {"error": "bad size"})
        try:
            d = json.loads(self.rfile.read(n))
            assert isinstance(d, dict)
        except Exception:
            return self._send(400, {"error": "bad json"})
        ip = self._client_ip()
        entry = {
            "ip": ip,
            "port": clean_int(d.get("port"), 1024, 65535, 7000),
            "name": clean_str(d.get("name", "Host"), 24) or "Host",
            "players": clean_int(d.get("players"), 0, 64, 1),
            "max": clean_int(d.get("max"), 1, 64, 14),
            "started": bool(d.get("started", False)),
            "mode": clean_str(d.get("mode", "classic"), 16),
            "ptype": clean_str(d.get("ptype", "batting"), 16),
            "version": clean_str(d.get("version", ""), 16),
        }
        if not entry["version"]:
            return self._send(400, {"error": "missing version"})
        key = "%s:%d" % (ip, entry["port"])
        now = time.time()
        with lock:
            prune(now)
            mine = [k for k, v in lobbies.items() if v["ip"] == ip and k != key]
            if len(mine) >= MAX_PER_IP or (key not in lobbies and len(lobbies) >= MAX_TOTAL):
                return self._send(429, {"error": "too many lobbies"})
            entry["_t"] = now
            lobbies[key] = entry
        self._send(200, {"ok": True})

    def do_HEAD(self):                      # some hosting sites check the service with HEAD
        self.send_response(200)
        self.end_headers()


if __name__ == "__main__":
    print("Lobby server on port %d (TRUST_PROXY=%s)" % (PORT, TRUST_PROXY))
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
