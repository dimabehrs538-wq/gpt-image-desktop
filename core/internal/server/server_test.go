package server

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/engine"
	"github.com/gpt-image-desktop/core/internal/store"
)

const apiKey = "sk-e2e-SECRET-abcdef123456"
const token = "local-test-token"

func pngOf(c color.Color, w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	png.Encode(&b, img)
	return b.Bytes()
}

// mockOpenAI 模拟 OpenAI 兼容接口。
func mockOpenAI(t *testing.T, editImages *int32) *httptest.Server {
	out := pngOf(color.RGBA{30, 120, 250, 255}, 64, 48)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+apiKey {
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"bad key","code":"invalid_api_key"}}`))
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			w.Write([]byte(`{"data":[{"id":"gpt-image-2"}]}`))
		case "/v1/images/generations":
			var body struct {
				N     int    `json:"n"`
				Model string `json:"model"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			if body.Model != "gpt-image-1" {
				w.WriteHeader(400)
				w.Write([]byte(`{"error":{"message":"unexpected model ` + body.Model + `"}}`))
				return
			}
			data := []map[string]string{}
			for i := 0; i < body.N; i++ {
				data = append(data, map[string]string{"b64_json": base64.StdEncoding.EncodeToString(out), "revised_prompt": "revised"})
			}
			json.NewEncoder(w).Encode(map[string]any{"data": data})
		case "/v1/images/edits":
			r.ParseMultipartForm(32 << 20)
			atomic.StoreInt32(editImages, int32(len(r.MultipartForm.File["image[]"])+len(r.MultipartForm.File["image"])))
			json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(out)}}})
		default:
			w.WriteHeader(404)
		}
	}))
}

type client struct {
	t    *testing.T
	base string
}

func (c client) do(method, path string, body any, out any) int {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.base+path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(raw), apiKey) {
		c.t.Fatalf("%s %s leaked api key: %s", method, path, raw)
	}
	if out != nil {
		json.Unmarshal(raw, out)
	}
	return resp.StatusCode
}

func TestEndToEnd(t *testing.T) {
	var editImages int32
	mock := mockOpenAI(t, &editImages)
	defer mock.Close()

	home := t.TempDir()
	outDir := filepath.Join(t.TempDir(), "output", "imagegen")
	g := config.NewStore(filepath.Join(home, "groups.json"))
	st := store.New(home, outDir)
	srv := New(token, engine.New(g, st, home), log.New(io.Discard, "", 0))
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	c := client{t, hs.URL}

	// 鉴权
	resp, _ := http.Get(hs.URL + "/api/status")
	if resp.StatusCode != 401 {
		t.Fatalf("unauth status=%d", resp.StatusCode)
	}
	if code := c.do("GET", "/api/status", nil, nil); code != 200 {
		t.Fatalf("status=%d", code)
	}

	// SSE 订阅
	evReq, _ := http.NewRequest("GET", hs.URL+"/api/events?token="+token, nil)
	evResp, err := http.DefaultClient.Do(evReq)
	if err != nil {
		t.Fatal(err)
	}
	defer evResp.Body.Close()
	events := make(chan string, 100)
	go func() {
		sc := bufio.NewScanner(evResp.Body)
		for sc.Scan() {
			if l := sc.Text(); strings.HasPrefix(l, "data: ") {
				events <- l[6:]
			}
		}
	}()

	// 配置 baseUrl / apiKey
	var pv map[string]string
	c.do("POST", "/api/groups/preview", map[string]any{"baseUrl": mock.URL + "/", "appendV1": true}, &pv)
	if pv["generationsUrl"] != mock.URL+"/v1/images/generations" {
		t.Fatalf("preview=%v", pv)
	}
	var gl struct {
		DefaultGroup string             `json:"defaultGroup"`
		Groups       []config.GroupView `json:"groups"`
	}
	if code := c.do("POST", "/api/groups", map[string]any{"name": "mock", "displayName": "本地 Mock", "baseUrl": mock.URL, "appendV1": true, "model": "gpt-image-1", "apiKey": apiKey}, &gl); code != 200 {
		t.Fatalf("create group code=%d", code)
	}
	if gl.DefaultGroup != "mock" || gl.Groups[0].KeyMask != "sk-••••3456" {
		t.Fatalf("groups=%+v", gl)
	}
	var probe map[string]any
	c.do("POST", "/api/groups/mock/test", nil, &probe)
	if probe["ok"] != true {
		t.Fatalf("probe=%v", probe)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(home, "groups.json"))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("groups.json perm=%v", fi.Mode().Perm())
		}
	}
	// 错误分组参数立即返回 400
	if code := c.do("POST", "/api/generate", map[string]any{"group": "nope", "prompt": "x"}, nil); code != 400 {
		t.Fatalf("unknown group code=%d", code)
	}

	waitJob := func(id string) Job {
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var j Job
			c.do("GET", "/api/jobs/"+id, nil, &j)
			if j.Status != "running" {
				return j
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("job timeout")
		return Job{}
	}

	// 文生图
	var job Job
	if code := c.do("POST", "/api/generate", map[string]any{"prompt": "一只猫", "size": "1024x1024", "quality": "high", "n": 2, "name": "cat"}, &job); code != 202 {
		t.Fatalf("generate code=%d", code)
	}
	job = waitJob(job.ID)
	if job.Status != "succeeded" || len(job.Items) != 2 {
		t.Fatalf("job=%+v", job)
	}
	if filepath.Base(job.Items[0].Path) != "cat-1.png" || job.Items[0].Width != 64 || job.Items[0].RevisedPrompt != "revised" || job.Items[0].Group != "mock" {
		t.Fatalf("item=%+v", job.Items[0])
	}
	// 再来一次同名不覆盖
	c.do("POST", "/api/generate", map[string]any{"prompt": "一只猫", "n": 2, "name": "cat"}, &job)
	job = waitJob(job.ID)
	if filepath.Base(job.Items[0].Path) != "cat-1-2.png" {
		t.Fatalf("no-overwrite path=%s", job.Items[0].Path)
	}
	// 显式指定其它模型：严格使用，不回退（mock 拒绝 → 失败且错误可读）
	c.do("POST", "/api/generate", map[string]any{"prompt": "x", "model": "dall-e-3"}, &job)
	job = waitJob(job.ID)
	if job.Status != "failed" || !strings.Contains(job.Error, "HTTP 400") || !strings.Contains(job.Error, "dall-e-3") {
		t.Fatalf("expected failure job=%+v", job)
	}

	// 图生图：一张 dataUrl + 一张来自上一张作品的本地路径
	ref := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngOf(color.White, 16, 16))
	var hist struct {
		Items []store.Item `json:"items"`
		Total int          `json:"total"`
	}
	c.do("GET", "/api/history", nil, &hist)
	if hist.Total != 4 {
		t.Fatalf("history total=%d", hist.Total)
	}
	c.do("POST", "/api/edit", map[string]any{"prompt": "合成", "images": []map[string]string{{"dataUrl": ref, "name": "参考.png"}, {"path": hist.Items[0].Path}}}, &job)
	job = waitJob(job.ID)
	if job.Status != "succeeded" || atomic.LoadInt32(&editImages) != 2 || len(job.Items[0].InputImages) != 2 {
		t.Fatalf("edit job=%+v images=%d", job, editImages)
	}
	if _, err := os.Stat(job.Items[0].InputImages[0]); err != nil {
		t.Fatalf("input copy missing: %v", err)
	}

	// 画廊查询 / 筛选
	c.do("GET", "/api/history?mode=edit", nil, &hist)
	if hist.Total != 1 || hist.Items[0].Mode != "edit" {
		t.Fatalf("edit filter=%+v", hist)
	}
	c.do("GET", "/api/history?q=%E7%8C%AB&group=mock", nil, &hist)
	if hist.Total != 4 {
		t.Fatalf("keyword filter total=%d", hist.Total)
	}

	// 本地图片读取与缩略图
	for _, p := range []string{"/api/files?path=", "/api/thumb?w=32&path="} {
		r2, _ := http.Get(hs.URL + p + urlq(hist.Items[0].Path) + "&token=" + token)
		body, _ := io.ReadAll(r2.Body)
		r2.Body.Close()
		if r2.StatusCode != 200 || len(body) == 0 {
			t.Fatalf("%s status=%d", p, r2.StatusCode)
		}
	}
	r3, _ := http.Get(hs.URL + "/api/files?path=" + urlq(filepath.Join(home, "groups.json")) + "&token=" + token)
	if r3.StatusCode != 404 {
		t.Fatalf("non-image file should be refused: %d", r3.StatusCode)
	}

	// 删除记录（同时删除文件）
	victim := hist.Items[0]
	if code := c.do("DELETE", "/api/history/"+victim.ID+"?deleteFile=1", nil, nil); code != 200 {
		t.Fatalf("delete code=%d", code)
	}
	if _, err := os.Stat(victim.Path); !os.IsNotExist(err) {
		t.Fatal("file not deleted")
	}

	// 设置
	var sres store.Settings
	newOut := filepath.Join(t.TempDir(), "o2")
	c.do("PUT", "/api/settings", map[string]any{"outputDir": newOut}, &sres)
	if sres.OutputDir != newOut {
		t.Fatalf("settings=%+v", sres)
	}

	// 导出不含密钥
	var exp config.File
	c.do("GET", "/api/groups/export", nil, &exp)
	if exp.Groups["mock"] == nil || exp.Groups["mock"].APIKey != "" {
		t.Fatalf("export=%+v", exp)
	}

	// SSE 至少收到 hello / groups / job / history
	seen := map[string]bool{}
	timeout := time.After(2 * time.Second)
loop:
	for {
		select {
		case raw := <-events:
			var ev Event
			json.Unmarshal([]byte(raw), &ev)
			seen[ev.Type] = true
			if seen["hello"] && seen["groups"] && seen["job"] && seen["history"] && seen["settings"] {
				break loop
			}
		case <-timeout:
			t.Fatalf("missing events: %v", seen)
		}
	}
}

func urlq(s string) string { return url.QueryEscape(s) }
