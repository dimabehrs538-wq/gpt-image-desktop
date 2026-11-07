package models

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
)

const keyA = "sk-groupA-SECRET-1111aaaa"
const keyB = "sk-groupB-SECRET-2222bbbb"

func TestParseAndFilter(t *testing.T) {
	ids, err := ParseList([]byte(`{"object":"list","data":[{"id":"gpt-image-1"},{"id":"dall-e-3"},{"id":"GPT-Image-2"},{"id":"gpt-image-1"},{"id":" chatgpt-image-latest "},{"id":42},{"name":"x"},{"id":""},"str",{"id":"text-embedding-3-small"},{"id":"Imagen-4"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 6 {
		t.Fatalf("去重后应有 6 个 ID：%v", ids)
	}
	got := FilterImage(append(ids, "gpt-image-1", "IMAGE-x", "image-x"))
	want := []string{"chatgpt-image-latest", "gpt-image-1", "GPT-Image-2", "IMAGE-x", "image-x", "Imagen-4"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("筛选/排序：\n got %v\nwant %v", got, want)
	}
	for _, bad := range []string{``, `null`, `[]`, `{"models":["gpt-image-1"]}`, `{"data":{"id":"x"}}`, `{"data":null}`, `<html>502</html>`, `{"data":[1,2]}`} {
		if _, err := ParseList([]byte(bad)); err == nil {
			t.Errorf("畸形响应 %q 应报错", bad)
		}
	}
	if ids, err := ParseList([]byte(`{"data":[]}`)); err != nil || len(ids) != 0 {
		t.Fatalf("空列表应成功：%v %v", ids, err)
	}
}

func TestFingerprint(t *testing.T) {
	a := Fingerprint("https://a.com/v1", keyA)
	if a == "" || a == Fingerprint("https://b.com/v1", keyA) || a == Fingerprint("https://a.com/v1", keyB) {
		t.Fatal("指纹应随 baseUrl 与密钥变化")
	}
	if strings.Contains(a, "SECRET") || len(a) != 16 {
		t.Fatalf("指纹格式异常：%s", a)
	}
	if Fingerprint("https://a.com/v1", "") != "" {
		t.Fatal("无密钥时指纹为空")
	}
}

type upstream struct {
	srv   *httptest.Server
	hits  atomic.Int32
	mode  atomic.Value // string
	lastA atomic.Value
}

func newUpstream(t *testing.T) *upstream {
	u := &upstream{}
	u.mode.Store("ok")
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.hits.Add(1)
		u.lastA.Store(r.Header.Get("Authorization"))
		auth := r.Header.Get("Authorization")
		switch {
		case strings.HasPrefix(r.URL.Path, "/a/") && auth != "Bearer "+keyA, strings.HasPrefix(r.URL.Path, "/b/") && auth != "Bearer "+keyB:
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"Incorrect API key provided: ` + strings.TrimPrefix(auth, "Bearer ") + `","code":"invalid_api_key"}}`))
			return
		}
		switch u.mode.Load().(string) {
		case "500":
			w.WriteHeader(500)
			w.Write([]byte(`upstream exploded`))
		case "html":
			w.Write([]byte(`<html>not json</html>`))
		case "nomodels":
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"message":"Invalid URL (GET /v1/models)"}}`))
		case "slow":
			time.Sleep(300 * time.Millisecond)
			w.Write([]byte(`{"data":[]}`))
		default:
			if strings.HasPrefix(r.URL.Path, "/a/") {
				w.Write([]byte(`{"data":[{"id":"gpt-image-1"},{"id":"gpt-4o"},{"id":"gpt-image-1"},{"id":"dall-e-3"}]}`))
			} else {
				w.Write([]byte(`{"data":[{"id":"flux-image-pro"},{"id":"seedream-image-3"}]}`))
			}
		}
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func cur(name, base, key string) Current {
	return Current{Name: name, EffectiveBaseURL: base, Fingerprint: Fingerprint(base, key)}
}

func TestRefreshIsolationPersistenceAndErrors(t *testing.T) {
	u := newUpstream(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "models.json")
	c := New(path)
	ctx := context.Background()
	ca, cb := cur("A", u.srv.URL+"/a/v1", keyA), cur("B", u.srv.URL+"/b/v1", keyB)

	r := c.Refresh(ctx, ca, keyA, nil)
	if !r.OK || !reflect.DeepEqual(r.Cache.Models, []string{"gpt-image-1"}) || r.Cache.Total != 3 {
		t.Fatalf("A 刷新：%+v", r)
	}
	if got := u.lastA.Load(); got != "Bearer "+keyA {
		t.Fatalf("A 应使用自己的密钥，实际 %v", got)
	}
	r = c.Refresh(ctx, cb, keyB, nil)
	if !r.OK || !reflect.DeepEqual(r.Cache.Models, []string{"flux-image-pro", "seedream-image-3"}) {
		t.Fatalf("B 刷新：%+v", r)
	}
	// 3 秒内重复刷新直接返回缓存，不再请求上游
	n := u.hits.Load()
	if r = c.Refresh(ctx, ca, keyA, nil); !r.OK || u.hits.Load() != n {
		t.Fatalf("短时间重复刷新不应再次请求上游")
	}

	// 重启：新实例读取磁盘缓存
	c2 := New(path)
	if v := c2.View(ca); !reflect.DeepEqual(v.Models, []string{"gpt-image-1"}) || v.Stale || v.FetchedAt == 0 {
		t.Fatalf("重启后 A 缓存：%+v", v)
	}
	if v := c2.View(cb); len(v.Models) != 2 {
		t.Fatalf("重启后 B 缓存：%+v", v)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "SECRET") {
		t.Fatal("models.json 不应包含密钥")
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(path); fi.Mode().Perm() != 0o600 {
			t.Fatalf("models.json 权限 %v", fi.Mode().Perm())
		}
	}

	// 失败时保留旧缓存并记录明确状态
	old := c2.View(ca)
	time.Sleep(10 * time.Millisecond)
	for _, m := range []string{"500", "html", "nomodels"} {
		u.mode.Store(m)
		c3 := New(path)
		c3.HTTP = c.HTTP
		// 绕过 3 秒去重：把 fetchedAt 改早
		e := c3.get("A")
		e.FetchedAt -= 10_000
		c3.put("A", e)
		r = c3.Refresh(ctx, ca, keyA, nil)
		if r.OK || r.Message == "" || !reflect.DeepEqual(r.Cache.Models, old.Models) || r.Cache.Error == "" || r.Cache.ErrorAt == 0 {
			t.Fatalf("%s：失败应保留旧列表并给出状态：%+v", m, r)
		}
		if m == "nomodels" && (!strings.Contains(r.Message, "不支持 GET /models") || r.Cache.ErrorStatus != 404) {
			t.Fatalf("404 提示：%s", r.Message)
		}
		if m == "html" && !strings.Contains(r.Message, "手动输入") {
			t.Fatalf("畸形响应提示：%s", r.Message)
		}
	}
	u.mode.Store("ok")

	// 401：错误信息中的密钥被脱敏
	wrong := "sk-wrong-SECRET-9999zzzz"
	cw := cur("W", u.srv.URL+"/a/v1", wrong)
	r = c.Refresh(ctx, cw, wrong, nil)
	if r.OK || r.Cache.ErrorStatus != 401 || strings.Contains(r.Message, wrong) || len(r.Cache.Models) != 0 {
		t.Fatalf("401：%+v", r)
	}

	// 端点变化：旧列表标记过期且不再返回；刷新失败也不会复用旧列表
	moved := cur("A", u.srv.URL+"/b/v1", keyA) // 新地址用 A 的密钥 → 401
	if v := c.View(moved); !v.Stale || len(v.Models) != 0 {
		t.Fatalf("端点变化后应过期：%+v", v)
	}
	r = c.Refresh(ctx, moved, keyA, nil)
	if r.OK || len(r.Cache.Models) != 0 || r.Cache.Stale {
		t.Fatalf("新端点失败不应复用旧列表：%+v", r)
	}
	// 密钥变化同样过期
	if v := c.View(cur("B", u.srv.URL+"/b/v1", "sk-other-key-000000")); !v.Stale {
		t.Fatal("密钥变化后应过期")
	}

	// 密钥解析失败：不发请求
	n = u.hits.Load()
	r = c.Refresh(ctx, Current{Name: "E", EffectiveBaseURL: u.srv.URL + "/a/v1"}, "", errors.New("环境变量 X 为空"))
	if r.OK || u.hits.Load() != n {
		t.Fatal("密钥解析失败时不应请求上游")
	}

	// 改名 / 删除
	if err := c.Rename("B", "B2"); err != nil {
		t.Fatal(err)
	}
	if v := c.View(cur("B2", u.srv.URL+"/b/v1", keyB)); len(v.Models) != 2 {
		t.Fatalf("改名后缓存应迁移：%+v", v)
	}
	if v := c.View(cb); len(v.Models) != 0 {
		t.Fatal("旧名不应再有缓存")
	}
	c.Remove("B2")
	if v := c.View(cur("B2", u.srv.URL+"/b/v1", keyB)); v.FetchedAt != 0 {
		t.Fatal("删除后缓存应清除")
	}

	// 空列表
	u.mode.Store("slow")
	ce := cur("S", u.srv.URL+"/a/v1", keyA)
	r = c.Refresh(ctx, ce, keyA, nil)
	if !r.OK || r.Cache.Total != 0 || !strings.Contains(r.Message, "为空") {
		t.Fatalf("空列表：%+v", r)
	}
}

func TestTimeout(t *testing.T) {
	u := newUpstream(t)
	u.mode.Store("slow")
	c := New(filepath.Join(t.TempDir(), "m.json"))
	c.HTTP = &http.Client{Timeout: 50 * time.Millisecond}
	r := c.Refresh(context.Background(), cur("A", u.srv.URL+"/a/v1", keyA), keyA, nil)
	if r.OK || !strings.Contains(r.Message, "超时") {
		t.Fatalf("超时：%+v", r)
	}
}

func TestViewsOnlyExistingGroups(t *testing.T) {
	u := newUpstream(t)
	c := New(filepath.Join(t.TempDir(), "m.json"))
	c.Refresh(context.Background(), cur("A", u.srv.URL+"/a/v1", keyA), keyA, nil)
	cfg := &config.File{Groups: map[string]*config.Group{
		"A": {BaseURL: u.srv.URL + "/a", AppendV1: true, APIKey: keyA},
		"N": {BaseURL: "https://new.example.com", APIKey: keyB},
		"E": {BaseURL: "https://env.example.com", APIKeyEnv: "GPTIMG_TEST_NOT_SET_ENV"},
	}}
	vs := c.Views(cfg)
	if len(vs) != 3 || len(vs["A"].Models) != 1 || vs["N"].FetchedAt != 0 || vs["N"].Stale || vs["E"].Stale {
		t.Fatalf("Views：%+v", vs)
	}
	if vs["A"].Filter != "image" || vs["N"].Models == nil {
		t.Fatal("视图字段应固定且 models 非 null")
	}
}
