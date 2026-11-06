#!/usr/bin/env bash
# 协议一致性对比：同时启动 Go 桌面内核与 Rust 移动内核，发送相同请求，逐个比较响应 JSON 的字段结构与状态码。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; MOCK_PORT=${MOCK_PORT:-18380}; KEY="sk-mock-CMP-secret-112233"; TOKEN="cmp-token"
cleanup() { kill ${PIDS:-} 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
(cd "$ROOT/core" && go build -o "$TMP/go-core" ./cmd/imagegend)
(cd "$ROOT/app/src-tauri" && cargo build -q -p imagegen-mobile-core --example serve && cp target/debug/examples/serve "$TMP/rust-core")
python3 "$ROOT/scripts/mock-openai.py" --port "$MOCK_PORT" --key "$KEY" > /dev/null 2>&1 & PIDS="$!"
"$TMP/go-core" serve --home "$TMP/go" --api-port 18391 --token "$TOKEN" --output-dir "$TMP/go/out" > /dev/null 2>&1 & PIDS="$PIDS $!"
"$TMP/rust-core" serve --home "$TMP/rs" --api-port 18392 --token "$TOKEN" --output-dir "$TMP/rs/out" > /dev/null 2>&1 & PIDS="$PIDS $!"
for p in 18391 18392; do for i in $(seq 50); do curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$p/api/status" && break; sleep 0.1; done; done
MOCK_PORT=$MOCK_PORT KEY=$KEY TOKEN=$TOKEN python3 - <<'PY'
import json, os, time, urllib.request, base64, sys
T=os.environ["TOKEN"]; M=os.environ["MOCK_PORT"]; K=os.environ["KEY"]
def call(port, method, path, body=None, raw=None, auth=True):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method)
    if auth: req.add_header("Authorization", f"Bearer {T}")
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
def shape(v):
    if isinstance(v, dict): return {k: shape(x) for k, x in sorted(v.items())}
    if isinstance(v, list): return [shape(v[0])] if v else []
    return type(v).__name__ if not isinstance(v, (int, float)) or isinstance(v, bool) else "number"
png = base64.b64encode(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082")).decode()
steps = [
  ("未授权", "GET", "/api/status", None, False),
  ("创建分组", "POST", "/api/groups", {"name":"mock","displayName":"Mock","baseUrl":f"http://127.0.0.1:{M}","appendV1":True,"model":"gpt-image-2","apiKey":K,"makeDefault":True}, True),
  ("重复分组", "POST", "/api/groups", {"name":"mock","baseUrl":f"http://127.0.0.1:{M}","apiKey":K}, True),
  ("非法 JSON", "POST", "/api/groups", "RAW:{bad", True),
  ("预览", "POST", "/api/groups/preview", {"baseUrl":"https://api.openai.com","appendV1":False}, True),
  ("预览错误", "POST", "/api/groups/preview", {"baseUrl":"ftp://x","appendV1":True}, True),
  ("测试连接", "POST", "/api/groups/mock/test", None, True),
  ("测试不存在", "POST", "/api/groups/none/test", None, True),
  ("导出", "GET", "/api/groups/export", None, True),
  ("导入", "POST", "/api/groups/import", {"json": json.dumps({"default_group":"x","groups":{"x":{"base_url":"https://x.com","api_key":"sk-xxxxxxxxxxxx","model":"m"}}})}, True),
  ("导入空", "POST", "/api/groups/import", {"json": "{}"}, True),
  ("设为默认", "POST", "/api/groups/mock/default", None, True),
  ("更新分组", "PUT", "/api/groups/x", {"baseUrl":"https://x.com/v1","model":"m2","apiKey":""}, True),
  ("删除分组", "DELETE", "/api/groups/x", None, True),
  ("删除不存在", "DELETE", "/api/groups/x", None, True),
  ("分组列表", "GET", "/api/groups", None, True),
  ("设置", "GET", "/api/settings", None, True),
  ("设置非法", "PUT", "/api/settings", {"requestTimeoutSec": 1}, True),
  ("设置更新", "PUT", "/api/settings", {"filenamePrefix": "cmp"}, True),
  ("生成参数错误", "POST", "/api/generate", {"prompt":""}, True),
  ("生成", "POST", "/api/generate", {"prompt":"cat","n":2,"size":"1024x1024"}, True),
  ("编辑", "POST", "/api/edit", {"prompt":"edit","images":[{"dataUrl":"data:image/png;base64,"+png,"name":"a.png"}],"mask":{"dataUrl":png}}, True),
  ("编辑无图", "POST", "/api/edit", {"prompt":"edit"}, True),
  ("上传", "POST", "/api/uploads?name=x.png", "BIN", True),
  ("任务列表", "GET", "/api/jobs", None, True),
  ("任务不存在", "GET", "/api/jobs/nope", None, True),
  ("历史", "GET", "/api/history?limit=10", None, True),
  ("历史不存在", "GET", "/api/history/nope", None, True),
  ("删除历史不存在", "DELETE", "/api/history/nope", None, True),
  ("状态", "GET", "/api/status", None, True),
]
bad = 0
for name, method, path, body, auth in steps:
    res = []
    for port in (18391, 18392):
        raw = None
        if body == "BIN": raw, b = base64.b64decode(png), None
        elif isinstance(body, str) and body.startswith("RAW:"): raw, b = body[4:].encode(), None
        else: b = body
        code, data = call(port, method, path, b, raw, auth)
        if name in ("生成", "编辑"):
            for _ in range(50):
                c2, j = call(port, "GET", f"/api/jobs/{data['id']}")
                if j["status"] != "running": data = j; break
                time.sleep(0.1)
        res.append((code, shape(data)))
    same = res[0] == res[1]
    bad += not same
    print(("  ✓ " if same else "  ✗ ") + f"{name:<10} {method} {path}  HTTP {res[0][0]}" + ("" if same else f"\n    Go:   {res[0]}\n    Rust: {res[1]}"))
print("\n协议一致性：" + ("全部一致 ✔" if not bad else f"{bad} 处不一致 ✗"))
sys.exit(1 if bad else 0)
PY
