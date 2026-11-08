package engine

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/imageapi"
	"github.com/gpt-image-desktop/core/internal/store"
)

const testKey = "sk-count-SECRET-778899"

func tinyPNG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	img.Set(0, 0, color.White)
	var b bytes.Buffer
	_ = png.Encode(&b, img)
	return b.Bytes()
}

// fakeAPI 可配置的生图接口：cap 为每次最多返回张数（0 = 按 n），bad 为损坏的条目序号，
// failFrom 为从第几次请求起返回 500（0 = 不失败），empty 返回空 data，delay 每次请求延迟。
type fakeAPI struct {
	mu       sync.Mutex
	cap      int
	bad      map[int]bool
	failFrom int
	empty    bool
	delay    time.Duration
	ns       []int
	paths    []string
}

func (f *fakeAPI) server(t *testing.T) *httptest.Server {
	img := base64.StdEncoding.EncodeToString(tinyPNG())
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := 1
		if strings.HasSuffix(r.URL.Path, "/edits") {
			_ = r.ParseMultipartForm(8 << 20)
			if v := r.FormValue("n"); v != "" {
				n, _ = strconv.Atoi(v)
			}
		} else {
			var body struct {
				N int `json:"n"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body.N > 0 {
				n = body.N
			}
		}
		f.mu.Lock()
		f.ns = append(f.ns, n)
		f.paths = append(f.paths, r.URL.Path)
		call := len(f.ns)
		f.mu.Unlock()
		if f.delay > 0 {
			select {
			case <-time.After(f.delay):
			case <-r.Context().Done():
				return
			}
		}
		if f.failFrom > 0 && call >= f.failFrom {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"error":{"message":"upstream overloaded","code":"server_error"}}`))
			return
		}
		if f.cap > 0 && n > f.cap {
			n = f.cap
		}
		if f.empty {
			n = 0
		}
		data := []map[string]string{}
		for i := 0; i < n; i++ {
			if f.bad[i] {
				data = append(data, map[string]string{"b64_json": "@@bad@@"})
			} else {
				data = append(data, map[string]string{"b64_json": img})
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": data})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newEngine(t *testing.T, policy string) (*Engine, string) {
	dir := t.TempDir()
	st := store.New(filepath.Join(dir, "home"), filepath.Join(dir, "out"))
	if policy != "" {
		if _, err := st.UpdateSettings(store.SettingsPatch{MissingPolicy: &policy}); err != nil {
			t.Fatal(err)
		}
	}
	return New(config.NewStore(filepath.Join(dir, "groups.json")), st, filepath.Join(dir, "home")), dir
}

func prepared(url, mode string, n int) *Prepared {
	p := &Prepared{
		Req:      Request{Mode: mode, Group: "g", Model: "gpt-image-2", Prompt: "四只猫", N: n},
		Endpoint: &config.Endpoint{Group: "g", BaseURL: url + "/v1", Key: testKey, Model: "gpt-image-2"},
	}
	if mode == "edit" {
		p.Images = []imageapi.InputImage{{Name: "ref.png", Data: tinyPNG()}}
	}
	return p
}

func check(t *testing.T, o *Outcome, status string, requested, received, saved, failed, requests int) {
	t.Helper()
	if o.Status() != status || o.Requested != requested || o.Received != received || o.Saved != saved || o.Failed != failed || o.Requests != requests || len(o.Items) != saved {
		t.Fatalf("got status=%s requested=%d received=%d saved=%d failed=%d requests=%d items=%d notes=%v err=%v; want %s %d %d %d %d %d",
			o.Status(), o.Requested, o.Received, o.Saved, o.Failed, o.Requests, len(o.Items), o.Notes, o.Err, status, requested, received, saved, failed, requests)
	}
	if strings.Contains(o.Summary(), testKey) {
		t.Fatal("summary leaks key")
	}
	for i, it := range o.Items {
		if it.Index != i || it.N != requested {
			t.Fatalf("item %d index=%d n=%d", i, it.Index, it.N)
		}
		if _, err := os.Stat(it.Path); err != nil {
			t.Fatalf("item %d file missing: %v", i, err)
		}
	}
}

func historyCount(t *testing.T, e *Engine) int {
	_, total := e.Store.List(store.Query{Limit: 100})
	return total
}

func TestCountsNormal(t *testing.T) {
	for _, mode := range []string{"generate", "edit"} {
		f := &fakeAPI{}
		e, _ := newEngine(t, "")
		o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, mode, 4), nil)
		check(t, o, "succeeded", 4, 4, 4, 0, 1)
		if len(f.ns) != 1 || f.ns[0] != 4 || len(o.Notes) != 0 {
			t.Fatalf("%s ns=%v notes=%v", mode, f.ns, o.Notes)
		}
		if filepath.Base(o.Items[3].Path) != filepath.Base(strings.TrimSuffix(o.Items[0].Path, "-1.png"))+"-4.png" {
			t.Fatalf("names %s %s", o.Items[0].Path, o.Items[3].Path)
		}
	}
}

// 根因复现：接口忽略 n 只返回 1 张。修复前任务被当作成功、只有 1 张。
func TestProviderReturnsOneFill(t *testing.T) {
	for _, mode := range []string{"generate", "edit"} {
		f := &fakeAPI{cap: 1}
		e, _ := newEngine(t, "")
		var progress []int
		o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, mode, 4), func(o *Outcome) { progress = append(progress, o.Saved) })
		check(t, o, "succeeded", 4, 4, 4, 0, 4)
		if fmtInts(f.ns) != "[4 1 1 1]" {
			t.Fatalf("%s requested n per call=%v（补图应每次 n=1）", mode, f.ns)
		}
		if f.paths[0] != f.paths[3] {
			t.Fatalf("补图必须使用同一接口 %v", f.paths)
		}
		if !strings.Contains(o.Summary(), "接口只返回了 1/4 张") || !strings.Contains(o.Summary(), "已逐张补请求 3 次") {
			t.Fatalf("notes=%v", o.Notes)
		}
		if progress[0] != 1 || progress[len(progress)-1] != 4 || historyCount(t, e) != 4 {
			t.Fatalf("progress=%v history=%d", progress, historyCount(t, e))
		}
	}
}

func TestProviderReturnsTwo(t *testing.T) {
	f := &fakeAPI{cap: 2}
	e, _ := newEngine(t, "")
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "succeeded", 4, 4, 4, 0, 3)
	if fmtInts(f.ns) != "[4 1 1]" {
		t.Fatalf("ns=%v", f.ns)
	}
}

func TestReportPolicyNoFill(t *testing.T) {
	f := &fakeAPI{cap: 1}
	e, _ := newEngine(t, store.MissingReport)
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "partial", 4, 1, 1, 0, 1)
	if !strings.Contains(o.Summary(), "接口只返回了 1/4 张") || !strings.Contains(o.Summary(), "未自动补图") {
		t.Fatalf("notes=%v", o.Notes)
	}
	// CLI 路径：不足张数不能当成功
	items, err := e.Run(context.Background(), "j2", prepared(f.server(t).URL, "generate", 4))
	if err == nil || len(items) != 1 || !strings.Contains(err.Error(), "期望 4 张，实际保存 1 张") {
		t.Fatalf("run items=%d err=%v", len(items), err)
	}
}

func TestFillStopsOnError(t *testing.T) {
	f := &fakeAPI{cap: 1, failFrom: 3}
	e, _ := newEngine(t, "")
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "partial", 4, 2, 2, 0, 3)
	if !strings.Contains(o.Summary(), "第 3 次请求（补图）失败") || !strings.Contains(o.Summary(), "HTTP 500") {
		t.Fatalf("summary=%s", o.Summary())
	}
}

func TestFirstRequestFails(t *testing.T) {
	f := &fakeAPI{failFrom: 1}
	e, _ := newEngine(t, "")
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "failed", 4, 0, 0, 0, 1)
	if strings.Contains(o.Summary(), "补图") {
		t.Fatal(o.Summary())
	}
}

func TestEmptyData(t *testing.T) {
	f := &fakeAPI{empty: true}
	e, _ := newEngine(t, "")
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "failed", 4, 0, 0, 0, 1) // 返回 0 张不补，避免无限请求
}

func TestPartialDecodeKeepsGoodAndNoFill(t *testing.T) {
	f := &fakeAPI{bad: map[int]bool{1: true}}
	e, _ := newEngine(t, "")
	o := e.Execute(context.Background(), "j", prepared(f.server(t).URL, "generate", 4), nil)
	// 第 2 张损坏：保留其余 3 张、计 1 张失败；损坏的图片接口已生成，不自动补
	check(t, o, "partial", 4, 4, 3, 1, 1)
	if !strings.Contains(o.Summary(), "第 2 张图片 b64_json 解码失败") {
		t.Fatal(o.Summary())
	}
}

func TestCancelKeepsSaved(t *testing.T) {
	f := &fakeAPI{cap: 1, delay: 300 * time.Millisecond}
	e, _ := newEngine(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	o := e.Execute(ctx, "j", prepared(f.server(t).URL, "generate", 4), func(o *Outcome) {
		if o.Saved == 1 {
			cancel()
		}
	})
	check(t, o, "canceled", 4, 1, 1, 0, 2)
	if !strings.Contains(o.Summary(), "已取消，保留已生成的 1 张") || historyCount(t, e) != 1 {
		t.Fatalf("summary=%s history=%d", o.Summary(), historyCount(t, e))
	}
	cancel()
}

func TestCancelBeforeAnyImage(t *testing.T) {
	f := &fakeAPI{delay: 2 * time.Second}
	e, _ := newEngine(t, "")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	o := e.Execute(ctx, "j", prepared(f.server(t).URL, "generate", 4), nil)
	check(t, o, "canceled", 4, 0, 0, 0, 1)
}

func fmtInts(v []int) string {
	s := make([]string, len(v))
	for i, x := range v {
		s[i] = strconv.Itoa(x)
	}
	return "[" + strings.Join(s, " ") + "]"
}
