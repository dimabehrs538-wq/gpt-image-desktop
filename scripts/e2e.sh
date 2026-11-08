#!/usr/bin/env bash
# 端到端联调：启动 Mock OpenAI + 内核，跑通 配置 baseUrl/apiKey → 测试连接 → 文生图 → 图生图 → 画廊查询 闭环
# CORE=go（默认，桌面端 Go imagegend）或 CORE=rust（移动端 Android / iOS 进程内 Rust 内核），两者共用同一套协议断言
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"; MOCK_PORT=${MOCK_PORT:-18080}; API_PORT=${API_PORT:-18091}
KEY="sk-mock-E2E-secret-998877"; TOKEN="e2e-$(date +%s)-token"
BIN="$TMP/imagegend"
cleanup() { kill ${MOCK_PID:-} ${CORE_PID:-} 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

CORE=${CORE:-go}
if [ "$CORE" = rust ]; then
  MC="$ROOT/app/src-tauri"
  (cd "$MC" && cargo build -q -p imagegen-mobile-core --example serve)
  cp "$MC/target/debug/examples/serve" "$BIN"
else
  (cd "$ROOT/core" && go build -o "$BIN" ./cmd/imagegend)
fi
printf '\033[1;36m内核实现：%s\033[0m\n' "$CORE"
python3 "$ROOT/scripts/mock-openai.py" --port "$MOCK_PORT" --key "$KEY" > "$TMP/mock.log" 2>&1 & MOCK_PID=$!
"$BIN" serve --home "$TMP/home" --api-port "$API_PORT" --token "$TOKEN" --output-dir "$TMP/output/imagegen" > "$TMP/core.log" 2>&1 & CORE_PID=$!
for i in $(seq 50); do curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$API_PORT/api/status" && break; sleep 0.1; done

A=(-sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
U="http://127.0.0.1:$API_PORT"
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

step "鉴权：无 token 访问被拒绝"
code=$(curl -s -o /dev/null -w '%{http_code}' "$U/api/status"); [ "$code" = 401 ] && ok "HTTP 401" || fail "期望 401，实际 $code"
perm=$(stat -c %a "$TMP/home/daemon.json"); [ "$perm" = 600 ] && ok "daemon.json 权限 $perm" || fail "daemon.json 权限 $perm"

step "配置 baseUrl / apiKey（appendV1 自动补 /v1）"
r=$(curl "${A[@]}" -X POST "$U/api/groups" -d "{\"name\":\"mock\",\"displayName\":\"本地 Mock\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT\",\"appendV1\":true,\"model\":\"gpt-image-2\",\"apiKey\":\"$KEY\",\"makeDefault\":true}")
echo "$r" | grep -q "$KEY" && fail "响应泄露了明文 apiKey"
ok "keyMask=$(echo "$r" | j 'd["groups"][0]["keyMask"]')  generations=$(echo "$r" | j 'd["groups"][0]["generationsUrl"]')"
perm=$(stat -c %a "$TMP/home/groups.json"); [ "$perm" = 600 ] && ok "groups.json 权限 $perm" || fail "groups.json 权限 $perm"
curl "${A[@]}" -X POST "$U/api/groups" -d "{\"name\":\"badkey\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/v1\",\"model\":\"gpt-image-2\",\"apiKey\":\"sk-wrong-key-00001111\"}" > /dev/null

step "测试连接"
r=$(curl "${A[@]}" -X POST "$U/api/groups/mock/test"); [ "$(echo "$r" | j 'd["ok"]')" = True ] && [ "$(echo "$r" | j 'd["modelCount"]')" = 6 ] && ok "$(echo "$r" | j 'd["message"]') · $(echo "$r" | j 'd["latencyMs"]') ms" || fail "$r"
r=$(curl "${A[@]}" -X POST "$U/api/groups/badkey/test"); echo "$r" | grep -q "sk-wrong-key-00001111" && fail "错误信息泄露密钥"
ok "错误密钥：$(echo "$r" | j 'd["message"]')"

step "拉取模型列表（GET /models，名称含 image 的自动保存，按分组隔离）"
r=$(curl "${A[@]}" -X POST "$U/api/groups/mock/models")
# mock 原始 data 7 条（gpt-image-1 重复一次）：total 语义为去重后的不同模型数 = 6
[ "$(echo "$r" | j 'd["cache"]["models"]')" = "['gpt-image-1', 'GPT-Image-1-Mini', 'gpt-image-2']" ] && [ "$(echo "$r" | j 'd["cache"]["total"]')" = 6 ] && ok "$(echo "$r" | j 'd["message"]')：$(echo "$r" | j '", ".join(d["cache"]["models"])')" || fail "$r"
curl "${A[@]}" -X POST "$U/api/groups" -d "{\"name\":\"alt\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/alt\",\"appendV1\":true,\"model\":\"flux-image-pro\",\"apiKey\":\"$KEY\"}" > /dev/null
r=$(curl "${A[@]}" -X POST "$U/api/groups/alt/models"); [ "$(echo "$r" | j 'd["cache"]["models"]')" = "['flux-image-pro', 'seedream-image-3']" ] && ok "另一分组独立列表：$(echo "$r" | j '", ".join(d["cache"]["models"])')" || fail "$r"
r=$(curl "${A[@]}" -X POST "$U/api/groups/badkey/models"); echo "$r" | grep -q "sk-wrong-key-00001111" && fail "拉取失败信息泄露密钥"
[ "$(echo "$r" | j 'd["ok"]')" = False ] && [ "$(echo "$r" | j 'd["cache"]["errorStatus"]')" = 401 ] && ok "错误密钥：$(echo "$r" | j 'd["message"]')" || fail "$r"
perm=$(stat -c %a "$TMP/home/models.json"); [ "$perm" = 600 ] && ok "models.json 权限 $perm" || fail "models.json 权限 $perm"
grep -q -e "$KEY" -e "sk-wrong-key-00001111" "$TMP/home/models.json" && fail "models.json 含密钥" || ok "models.json 不含密钥"
kill $CORE_PID; wait $CORE_PID 2>/dev/null || true
"$BIN" serve --home "$TMP/home" --api-port "$API_PORT" --token "$TOKEN" --output-dir "$TMP/output/imagegen" >> "$TMP/core.log" 2>&1 & CORE_PID=$!
for i in $(seq 50); do curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "$U/api/status" && break; sleep 0.1; done
r=$(curl "${A[@]}" "$U/api/models"); [ "$(echo "$r" | j 'len(d["groups"]["mock"]["models"]), len(d["groups"]["alt"]["models"])')" = "(3, 2)" ] && ok "重启内核后缓存仍在（mock 3 个 / alt 2 个）" || fail "$r"
r=$(curl "${A[@]}" "$U/api/groups"); [ "$(echo "$r" | j '[g["model"] for g in d["groups"] if g["name"]=="mock"][0]')" = gpt-image-2 ] && ok "分组默认模型未被改动"

wait_job() { for i in $(seq 100); do s=$(curl "${A[@]}" "$U/api/jobs/$1"); st=$(echo "$s" | j 'd["status"]'); [ "$st" != running ] && { echo "$s"; return; }; sleep 0.1; done; fail "任务超时"; }

step "文生图 /images/generations（n=2）"
job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"一只戴宇航员头盔的橘猫","size":"1536x1024","quality":"high","background":"opaque","outputFormat":"png","n":2,"name":"astro-cat"}' | j 'd["id"]')
s=$(wait_job "$job"); [ "$(echo "$s" | j 'd["status"]')" = succeeded ] || fail "$s"
ok "耗时 $(echo "$s" | j 'd["elapsedMs"]') ms，保存：$(echo "$s" | j '", ".join(i["path"].split("/")[-1] for i in d["items"])')"
FIRST=$(echo "$s" | j 'd["items"][0]["path"]')

step "防覆盖：同名再次生成"
job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"一只戴宇航员头盔的橘猫","n":1,"name":"astro-cat-1"}' | j 'd["id"]')
s=$(wait_job "$job"); name=$(echo "$s" | j 'd["items"][0]["path"].split("/")[-1]'); [ "$name" = "astro-cat-1-2.png" ] && ok "新文件 $name，原文件未被覆盖" || fail "$name"

step "url 返回格式（HTTP 下载落盘）"
job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"url test","model":"url-model"}' | j 'd["id"]')
s=$(wait_job "$job"); [ "$(echo "$s" | j 'd["items"][0]["sourceUrl"] != ""')" = True ] && ok "已下载 $(echo "$s" | j 'd["items"][0]["fileSize"]') 字节" || fail "$s"

step "严格模型：指定不存在的模型时失败且不回退"
job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"x","model":"fail-model"}' | j 'd["id"]')
s=$(wait_job "$job"); [ "$(echo "$s" | j 'd["status"]')" = failed ] && ok "$(echo "$s" | j 'd["error"]')" || fail "$s"

step "图生图 /images/edits（2 张参考图 + 蒙版，image[] 按顺序上传）"
REF=$(python3 -c "import base64,sys; sys.path.insert(0,'$ROOT/scripts'); import importlib.util as u; s=u.spec_from_file_location('m','$ROOT/scripts/mock-openai.py'); m=u.module_from_spec(s); s.loader.exec_module(m); print('data:image/png;base64,'+base64.b64encode(m.png(32,32,(255,255,255))).decode())")
job=$(curl "${A[@]}" -X POST "$U/api/edit" -d "{\"prompt\":\"以图 1 为底图，融合图 2 的配色\",\"n\":1,\"images\":[{\"dataUrl\":\"$REF\",\"name\":\"底图.png\"},{\"path\":\"$FIRST\"}],\"mask\":{\"dataUrl\":\"$REF\",\"name\":\"mask.png\"}}" | j 'd["id"]')
s=$(wait_job "$job"); [ "$(echo "$s" | j 'd["status"]')" = succeeded ] || fail "$s"
st=$(curl -s "http://127.0.0.1:$MOCK_PORT/__stats"); [ "$(echo "$st" | j 'd["last_edit_images"]')" = 2 ] && [ "$(echo "$st" | j 'd["last_edit_mask"]')" = True ] && ok "Mock 收到 2 张参考图 + 蒙版；输出 $(echo "$s" | j 'd["items"][0]["path"].split("/")[-1]')" || fail "$st"

step "直接上传图片文件流（移动端 / 浏览器选图）→ 以 path 引用编辑"
python3 -c "import base64,sys; print(sys.argv[1].split(',',1)[1])" "$REF" | base64 -d > "$TMP/upload.png"
up=$(curl "${A[@]}" -X POST -H "Content-Type: application/octet-stream" --data-binary @"$TMP/upload.png" "$U/api/uploads?name=%E7%9B%B8%E5%86%8C.png")
UP=$(echo "$up" | j 'd["path"]'); [ -f "$UP" ] && ok "已保存附件 $(basename "$UP")（$(echo "$up" | j 'd["size"]') 字节）" || fail "$up"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" --data-binary "not an image" "$U/api/uploads"); [ "$code" = 400 ] && ok "非图片上传被拒绝（400）" || fail "期望 400，实际 $code"
job=$(curl "${A[@]}" -X POST "$U/api/edit" -d "{\"prompt\":\"上传文件编辑\",\"images\":[{\"path\":\"$UP\"}],\"mask\":{\"path\":\"$UP\"}}" | j 'd["id"]')
s=$(wait_job "$job"); [ "$(echo "$s" | j 'd["status"]')" = succeeded ] && ok "上传附件编辑成功：$(echo "$s" | j 'd["items"][0]["path"].split("/")[-1]')" || fail "$s"

step "SSE 事件流"
curl -sN -m 2 "$U/api/events?token=$TOKEN" > "$TMP/sse.txt" 2>/dev/null || true
grep -q '"type":"hello"' "$TMP/sse.txt" && ok "收到 hello 事件" || fail "SSE：$(cat "$TMP/sse.txt")"

step "画廊查询 / 筛选"
r=$(curl "${A[@]}" "$U/api/history"); ok "全部 $(echo "$r" | j 'd["total"]') 张"
r=$(curl "${A[@]}" "$U/api/history?mode=edit"); [ "$(echo "$r" | j 'd["total"]')" = 2 ] && ok "图生图 2 张" || fail "$r"
r=$(curl "${A[@]}" "$U/api/history?q=%E6%A9%98%E7%8C%AB&group=mock"); [ "$(echo "$r" | j 'd["total"]')" = 3 ] && ok "关键词「橘猫」3 张" || fail "$r"
code=$(curl -s -o /dev/null -w '%{http_code}' "$U/api/thumb?w=128&token=$TOKEN&path=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$FIRST'))")"); [ "$code" = 200 ] && ok "缩略图接口 200" || fail "thumb $code"

step "删除记录（同时删除文件）"
ID=$(echo "$r" | j 'd["items"][0]["id"]'); P=$(echo "$r" | j 'd["items"][0]["path"]')
curl "${A[@]}" -X DELETE "$U/api/history/$ID?deleteFile=1" > /dev/null; [ ! -e "$P" ] && ok "已删除 $(basename "$P")" || fail "文件仍存在"

step "多张张数：接口少返回 / 部分失败 / 取消（期望、实际、失败、请求次数如实统计，保留部分成果）"
for v in cap1 cap2 badone failnext zero slow; do
  curl "${A[@]}" -X POST "$U/api/groups" -d "{\"name\":\"$v\",\"baseUrl\":\"http://127.0.0.1:$MOCK_PORT/$v\",\"appendV1\":true,\"model\":\"gpt-image-2\",\"apiKey\":\"$KEY\"}" > /dev/null
done
reset() { curl -s "http://127.0.0.1:$MOCK_PORT/__reset" > /dev/null; }
ns() { curl -s "http://127.0.0.1:$MOCK_PORT/__stats" | j '[c["n"] for c in d["calls"]]'; }
cnt() { echo "$1" | j '(d["status"], d["requested"], d["received"], d["saved"], d["failed"], d["requests"], len(d["items"]))'; }
r=$(curl "${A[@]}" "$U/api/settings"); [ "$(echo "$r" | j 'd["missingPolicy"]')" = fill ] && ok "默认 missingPolicy=fill" || fail "$r"
code=$(curl -s -o /dev/null -w '%{http_code}' "${A[@]}" -X PUT "$U/api/settings" -d '{"missingPolicy":"forever"}'); [ "$code" = 400 ] && ok "非法 missingPolicy 被拒绝（400）" || fail "期望 400，实际 $code"

reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"四张正常","n":4,"group":"mock"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('succeeded', 4, 4, 4, 0, 1, 4)" ] && [ "$(ns)" = "[4]" ] && ok "支持 n 的接口：1 次请求 4/4 张" || fail "$s $(ns)"

curl -sN -m 6 "$U/api/events?token=$TOKEN" > "$TMP/sse-count.txt" 2>/dev/null & SSE_PID=$!; sleep 0.3
reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"中转只回一张","n":4,"group":"cap1","name":"cap1"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('succeeded', 4, 4, 4, 0, 4, 4)" ] && [ "$(ns)" = "[4, 1, 1, 1]" ] || fail "$s $(ns)"
[ "$(echo "$s" | j 'sorted(i["path"].split("/")[-1] for i in d["items"]) == ["cap1-%d.png" % k for k in range(1,5)]')" = True ] || fail "文件名：$s"
[ "$(echo "$s" | j 'sorted(i["index"] for i in d["items"])')" = "[0, 1, 2, 3]" ] || fail "index：$s"
ok "只回 1 张的接口：逐张补请求（n=$(ns)），4/4 张，说明：$(echo "$s" | j '"；".join(d.get("notes", []))')"
wait $SSE_PID 2>/dev/null || true
python3 - "$TMP/sse-count.txt" "$job" <<'PY' && ok "SSE 逐张推送进度（saved 1→4）" || fail "SSE 进度：$(grep -c "$job" "$TMP/sse-count.txt")"
import json, sys
seen = []
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("data:"):
        d = json.loads(line[5:])
        if d.get("type") == "job" and d["data"]["id"] == sys.argv[2]:
            seen.append(d["data"]["saved"])
assert {1, 2, 3, 4} <= set(seen), seen
PY

reset; job=$(curl "${A[@]}" -X POST "$U/api/edit" -d "{\"prompt\":\"编辑中转只回两张\",\"n\":4,\"group\":\"cap2\",\"images\":[{\"path\":\"$UP\"}]}" | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('succeeded', 4, 4, 4, 0, 3, 4)" ] && [ "$(ns)" = "[4, 1, 1]" ] && [ "$(curl -s "http://127.0.0.1:$MOCK_PORT/__stats" | j 'set(c["path"] for c in d["calls"])')" = "{'/v1/images/edits'}" ] && ok "图生图同样补图：n=$(ns)，全部走 /images/edits" || fail "$s $(ns)"

curl "${A[@]}" -X PUT "$U/api/settings" -d '{"missingPolicy":"report"}' > /dev/null
reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"只报告","n":4,"group":"cap1"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('partial', 4, 1, 1, 0, 1, 1)" ] && [ "$(ns)" = "[4]" ] && ok "missingPolicy=report：不补图，标记 partial：$(echo "$s" | j 'd["error"]')" || fail "$s $(ns)"
reset; job=$(curl "${A[@]}" -X POST "$U/api/edit" -d "{\"prompt\":\"只报告编辑\",\"n\":4,\"group\":\"cap2\",\"images\":[{\"path\":\"$UP\"}]}" | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('partial', 4, 2, 2, 0, 1, 2)" ] && ok "图生图 report：2/4 张 partial" || fail "$s"
curl "${A[@]}" -X PUT "$U/api/settings" -d '{"missingPolicy":"fill"}' > /dev/null

reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"补图途中出错","n":4,"group":"failnext"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('partial', 4, 1, 1, 0, 2, 1)" ] && [ "$(ns)" = "[4, 1]" ] && echo "$s" | j 'd["error"]' | grep -q "第 2 次请求（补图）失败" && ok "补图出错立即停止（不重试），保留 1 张：$(echo "$s" | j 'd["error"]')" || fail "$s $(ns)"

reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"一张损坏","n":4,"group":"badone"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('partial', 4, 4, 3, 1, 1, 3)" ] && [ "$(ns)" = "[4]" ] && ok "单张解码失败：保留其余 3 张、失败 1 张、不补图：$(echo "$s" | j 'd["error"]')" || fail "$s $(ns)"

reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"空 data","n":4,"group":"zero"}' | j 'd["id"]'); s=$(wait_job "$job")
[ "$(cnt "$s")" = "('failed', 4, 0, 0, 0, 1, 0)" ] && [ "$(ns)" = "[4]" ] && ok "空 data：failed 且不补图：$(echo "$s" | j 'd["error"]')" || fail "$s $(ns)"

reset; job=$(curl "${A[@]}" -X POST "$U/api/generate" -d '{"prompt":"取消保留","n":4,"group":"slow"}' | j 'd["id"]')
for i in $(seq 60); do s=$(curl "${A[@]}" "$U/api/jobs/$job"); [ "$(echo "$s" | j 'd["saved"]')" -ge 1 ] && break; sleep 0.1; done
curl "${A[@]}" -X POST "$U/api/jobs/$job/cancel" > /dev/null; s=$(wait_job "$job")
[ "$(echo "$s" | j '(d["status"], d["saved"], len(d["items"]), d["requests"])')" = "('canceled', 1, 1, 2)" ] && [ -f "$(echo "$s" | j 'd["items"][0]["path"]')" ] || fail "$s"
r=$(curl "${A[@]}" "$U/api/history?group=slow"); [ "$(echo "$r" | j 'd["total"]')" = 1 ] && ok "补图途中取消：status=canceled，保留已生成 1 张（文件与历史都在）" || fail "$r"
sleep 1.6; [ "$(ns)" = "[4, 1]" ] && ok "取消后不再发起请求" || fail "$(ns)"

step "日志与配置中不含明文密钥"
grep -q "$KEY" "$TMP/core.log" "$TMP/home/logs/imagegend.log" && fail "日志泄露密钥" || ok "日志未出现明文 apiKey"

[ "$CORE" = rust ] && { printf '\n\033[1;32m全部端到端检查通过 ✔（Rust 移动内核）\033[0m\n'; exit 0; }

step "CLI 子命令"
"$BIN" groups --home "$TMP/home" | grep -q '"keyMask"' && ok "imagegend groups"
"$BIN" history --home "$TMP/home" --limit 1 | grep -q '"total"' && ok "imagegend history"
"$BIN" status --home "$TMP/home" | grep -q '"version"' && ok "imagegend status"
"$BIN" generate --home "$TMP/home" --prompt "CLI 生成" --name cli > /dev/null 2>&1 && ok "imagegend generate"

printf '\n\033[1;32m全部端到端检查通过 ✔\033[0m\n'
