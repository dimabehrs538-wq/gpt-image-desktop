#!/usr/bin/env python3
"""本地 Mock OpenAI 兼容生图接口（仅标准库），用于联调与端到端测试。

用法：python3 scripts/mock-openai.py [--port 18080] [--key sk-mock-123456789]
接口：GET /v1/models、POST /v1/images/generations、POST /v1/images/edits、GET /files/<name>.png
- 鉴权：Authorization: Bearer <key>，错误时返回 OpenAI 风格错误体
- model 为 "url-model" 时返回 url 字段（测试下载落盘），其余返回 b64_json
"""
import argparse, base64, json, re, struct, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


COLORS = [(124, 58, 237), (14, 165, 233), (236, 72, 153), (34, 197, 94)]


class H(BaseHTTPRequestHandler):
    key = ""
    stats = {"generations": 0, "edits": 0, "last_edit_images": 0}

    def log_message(self, fmt, *a):
        print("[mock]", fmt % a, flush=True)

    def send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        if self.headers.get("Authorization") != f"Bearer {self.key}":
            self.send(401, {"error": {"message": f"Incorrect API key provided: {self.headers.get('Authorization', '')[7:]}", "type": "invalid_request_error", "code": "invalid_api_key"}})
            return False
        return True

    def do_GET(self):
        if self.path.startswith("/files/"):
            return self.send(200, png(96, 64, COLORS[3]), "image/png")
        if self.path == "/__stats":
            return self.send(200, self.stats)
        if not self.authed():
            return
        if self.path == "/v1/models":
            return self.send(200, {"object": "list", "data": [{"id": m} for m in ("gpt-image-2", "gpt-image-1", "dall-e-3")]})
        self.send(404, {"error": {"message": "not found"}})

    def images(self, n, model, size, edit):
        w, h = (int(x) for x in size.split("x")) if re.fullmatch(r"\d+x\d+", size or "") else (64, 64)
        w, h = max(8, w // 16), max(8, h // 16)
        data = []
        for i in range(n):
            if model == "url-model":
                data.append({"url": f"http://{self.headers['Host']}/files/r{i}.png"})
            else:
                data.append({"b64_json": base64.b64encode(png(w, h, COLORS[(i + (2 if edit else 0)) % 4])).decode(), "revised_prompt": "mock revised prompt"})
        return {"created": 0, "data": data}

    def do_POST(self):
        if not self.authed():
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/v1/images/generations":
            req = json.loads(body or b"{}")
            if not req.get("prompt"):
                return self.send(400, {"error": {"message": "prompt is required", "code": "missing_prompt"}})
            if req.get("model") == "fail-model":
                return self.send(400, {"error": {"message": f"The model '{req['model']}' does not exist", "code": "model_not_found"}})
            H.stats["generations"] += 1
            return self.send(200, self.images(int(req.get("n", 1)), req.get("model"), req.get("size", ""), False))
        if self.path == "/v1/images/edits":
            text = body.decode("latin-1")
            imgs = len(re.findall(r'name="image(\[\])?"', text))
            if imgs == 0:
                return self.send(400, {"error": {"message": "image is required"}})
            model = re.search(r'name="model"\r\n\r\n([^\r]*)', text)
            n = re.search(r'name="n"\r\n\r\n(\d+)', text)
            H.stats["edits"] += 1
            H.stats["last_edit_images"] = imgs
            H.stats["last_edit_mask"] = 'name="mask"' in text
            return self.send(200, self.images(int(n.group(1)) if n else 1, model.group(1) if model else "", "", True))
        self.send(404, {"error": {"message": "not found"}})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18080)
    ap.add_argument("--key", default="sk-mock-1234567890abcd")
    a = ap.parse_args()
    H.key = a.key
    print(f"Mock OpenAI 已启动：http://127.0.0.1:{a.port}  key={a.key[:3]}••••{a.key[-4:]}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
