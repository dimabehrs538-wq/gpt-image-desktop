package server

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/engine"
	"github.com/gpt-image-desktop/core/internal/models"
	"github.com/gpt-image-desktop/core/internal/store"
)

// TestModelsAPI 多分组隔离、改名 / 删除、端点变化、重启后缓存、密钥不泄露。
func TestModelsAPI(t *testing.T) {
	const keyB = "sk-second-SECRET-778899aa"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Header.Get("Authorization") {
		case "Bearer " + apiKey:
			w.Write([]byte(`{"data":[{"id":"gpt-image-2"},{"id":"gpt-4.1"},{"id":"GPT-IMAGE-1"},{"id":"gpt-image-2"}]}`))
		case "Bearer " + keyB:
			w.Write([]byte(`{"data":[{"id":"flux-kontext"},{"id":"seedream-image"}]}`))
		default:
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"bad key"}}`))
		}
	}))
	defer up.Close()
	home := t.TempDir()
	mk := func() (*httptest.Server, client) {
		g := config.NewStore(filepath.Join(home, "groups.json"))
		st := store.New(home, filepath.Join(home, "out"))
		hs := httptest.NewServer(New(token, engine.New(g, st, home), log.New(io.Discard, "", 0)).Handler())
		return hs, client{t, hs.URL}
	}
	hs, c := mk()
	c.do("POST", "/api/groups", map[string]any{"name": "a", "baseUrl": up.URL, "appendV1": true, "apiKey": apiKey, "model": "my-custom-model"}, nil)
	c.do("POST", "/api/groups", map[string]any{"name": "b", "baseUrl": up.URL + "/v1", "apiKey": keyB}, nil)

	var all struct {
		Groups map[string]models.View `json:"groups"`
	}
	all.Groups = nil
	c.do("GET", "/api/models", nil, &all)
	if len(all.Groups) != 2 || all.Groups["a"].FetchedAt != 0 || all.Groups["a"].Models == nil {
		t.Fatalf("初始：%+v", all)
	}
	var res models.RefreshResult
	if code := c.do("POST", "/api/groups/a/models", nil, &res); code != 200 || !res.OK || !reflect.DeepEqual(res.Cache.Models, []string{"GPT-IMAGE-1", "gpt-image-2"}) || res.Cache.Total != 3 {
		t.Fatalf("a：%d %+v", code, res)
	}
	c.do("POST", "/api/groups/b/models", nil, &res)
	if !reflect.DeepEqual(res.Cache.Models, []string{"seedream-image"}) {
		t.Fatalf("b：%+v", res)
	}
	if code := c.do("POST", "/api/groups/none/models", nil, nil); code != 404 {
		t.Fatalf("不存在的分组应 404，实际 %d", code)
	}
	// 拉取模型不会改动分组的默认模型
	var gs struct{ Groups []config.GroupView }
	c.do("GET", "/api/groups", nil, &gs)
	if gs.Groups[0].Model != "my-custom-model" {
		t.Fatalf("分组默认模型被改动：%s", gs.Groups[0].Model)
	}

	// 重启后缓存仍在
	hs.Close()
	hs, c = mk()
	defer func() { hs.Close() }()
	all.Groups = nil
	c.do("GET", "/api/models", nil, &all)
	if len(all.Groups["a"].Models) != 2 || len(all.Groups["b"].Models) != 1 {
		t.Fatalf("重启后：%+v", all)
	}

	// 改名迁移缓存；修改 baseUrl 后旧列表过期
	c.do("PUT", "/api/groups/b", map[string]any{"newName": "b2", "baseUrl": up.URL + "/v1", "apiKey": ""}, nil)
	all.Groups = nil
	c.do("GET", "/api/models", nil, &all)
	if _, ok := all.Groups["b"]; ok || len(all.Groups["b2"].Models) != 1 {
		t.Fatalf("改名后：%+v", all)
	}
	c.do("PUT", "/api/groups/a", map[string]any{"baseUrl": up.URL + "/other", "appendV1": true, "apiKey": "", "model": "my-custom-model"}, nil)
	all.Groups = nil
	c.do("GET", "/api/models", nil, &all)
	if !all.Groups["a"].Stale || len(all.Groups["a"].Models) != 0 {
		t.Fatalf("端点变化后应过期：%+v", all.Groups["a"])
	}
	// 换成错误密钥 → 401，不泄露密钥、不复用旧列表
	c.do("PUT", "/api/groups/b2", map[string]any{"baseUrl": up.URL + "/v1", "apiKey": "sk-wrong-SECRET-00001111"}, nil)
	c.do("POST", "/api/groups/b2/models", nil, &res)
	if res.OK || res.Cache.ErrorStatus != 401 || len(res.Cache.Models) != 0 {
		t.Fatalf("错误密钥：%+v", res)
	}
	c.do("DELETE", "/api/groups/b2", nil, nil)
	raw, _ := os.ReadFile(filepath.Join(home, "models.json"))
	if strings.Contains(string(raw), "SECRET") || strings.Contains(string(raw), `"b2"`) {
		t.Fatalf("models.json：%s", raw)
	}
	logs, _ := os.ReadFile(filepath.Join(home, "logs", "imagegend.log"))
	if strings.Contains(string(logs), "SECRET") {
		t.Fatal("日志泄露密钥")
	}
}
