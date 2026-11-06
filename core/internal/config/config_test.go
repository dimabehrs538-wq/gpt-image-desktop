package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEffectiveBaseURL(t *testing.T) {
	cases := []struct {
		base string
		v1   bool
		want string
	}{
		{"https://api.openai.com", false, "https://api.openai.com/v1"},
		{"https://api.openai.com/", true, "https://api.openai.com/v1"},
		{"https://api.openai.com/v1", true, "https://api.openai.com/v1"},
		{"https://api.openai.com/v1/", false, "https://api.openai.com/v1"},
		{"https://relay.example.com", false, "https://relay.example.com"},
		{"https://relay.example.com", true, "https://relay.example.com/v1"},
		{"https://relay.example.com/openai/v1", true, "https://relay.example.com/openai/v1"},
		{"  http://127.0.0.1:8080/  ", true, "http://127.0.0.1:8080/v1"},
		{"", true, ""},
	}
	for _, c := range cases {
		if got := EffectiveBaseURL(c.base, c.v1); got != c.want {
			t.Errorf("EffectiveBaseURL(%q,%v)=%q want %q", c.base, c.v1, got, c.want)
		}
	}
}

func TestMaskAndRedact(t *testing.T) {
	if got := MaskKey("sk-proj-1234567890abcd"); got != "sk-••••abcd" {
		t.Fatalf("mask=%q", got)
	}
	if got := MaskKey("short"); got != "••••" {
		t.Fatalf("mask short=%q", got)
	}
	if MaskKey("") != "" {
		t.Fatal("empty mask")
	}
	key := "my-secret-token-XYZ987654"
	s := Redact("invalid key "+key+" and sk-abcdefghijklmnop1234 Bearer abcdefghijkl", key)
	if strings.Contains(s, key) || strings.Contains(s, "sk-abcdefghijklmnop1234") || strings.Contains(s, "abcdefghijkl") {
		t.Fatalf("not redacted: %s", s)
	}
}

func TestStorePermsAndKeepKey(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(filepath.Join(dir, "sub", "groups.json"))
	if err := s.Create(Input{Name: "bad name", BaseURL: "https://x"}); err == nil {
		t.Fatal("expected invalid name error")
	}
	if err := s.Create(Input{Name: "relay", BaseURL: "ftp://x", APIKey: "k"}); err == nil {
		t.Fatal("expected invalid url error")
	}
	if err := s.Create(Input{Name: "relay", BaseURL: "https://relay.example.com", AppendV1: true, APIKey: "sk-relay-secret-0001"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(s.Path())
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("perm=%v", fi.Mode().Perm())
		}
	}
	// 编辑时 apiKey 留空 → 保留原密钥
	if err := s.Modify("relay", Input{BaseURL: "https://relay2.example.com/v1", Model: "gpt-image-1", KeySource: "literal"}); err != nil {
		t.Fatal(err)
	}
	ep, err := s.Resolve("relay")
	if err != nil {
		t.Fatal(err)
	}
	if ep.Key != "sk-relay-secret-0001" || ep.BaseURL != "https://relay2.example.com/v1" || ep.Model != "gpt-image-1" {
		t.Fatalf("endpoint=%+v", ep)
	}
	def, views, _ := s.Views()
	if def != "relay" || len(views) != 1 || views[0].KeyMask != "sk-••••0001" {
		t.Fatalf("views=%+v def=%s", views, def)
	}
	raw, _ := json.Marshal(views)
	if strings.Contains(string(raw), "sk-relay-secret-0001") {
		t.Fatal("view leaks key")
	}
	if views[0].GenerationsURL != "https://relay2.example.com/v1/images/generations" || views[0].EditsURL != "https://relay2.example.com/v1/images/edits" {
		t.Fatalf("urls=%+v", views[0])
	}
	// 不存在的分组严格报错，不回退
	if _, err := s.Resolve("nope"); err == nil {
		t.Fatal("expected error for unknown group")
	}
	// 重命名 + 删除默认分组
	if err := s.Modify("relay", Input{NewName: "relay-b", BaseURL: "https://relay2.example.com/v1"}); err != nil {
		t.Fatal(err)
	}
	if def, _, _ := s.Views(); def != "relay-b" {
		t.Fatalf("default after rename=%s", def)
	}
	if err := s.Delete("relay-b"); err != nil {
		t.Fatal(err)
	}
}

func TestKeySources(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TEST_IMG_KEY", "sk-from-env-12345678")
	ref := filepath.Join(dir, "secret.json")
	os.WriteFile(ref, []byte(`{"providers":{"relay":{"key":"sk-from-ref-87654321"}}}`), 0o600)
	g := &Group{APIKeyEnv: "TEST_IMG_KEY"}
	if k, err := g.ResolveKey(); err != nil || k != "sk-from-env-12345678" {
		t.Fatalf("env key=%q err=%v", k, err)
	}
	g = &Group{APIKeyRef: &KeyRef{Path: ref, Field: "providers.relay.key"}}
	if k, err := g.ResolveKey(); err != nil || k != "sk-from-ref-87654321" {
		t.Fatalf("ref key=%q err=%v", k, err)
	}
	g = &Group{APIKeyRef: &KeyRef{Path: ref, Field: "providers.none"}}
	if _, err := g.ResolveKey(); err == nil {
		t.Fatal("expected missing field error")
	}
	g = &Group{APIKeyEnv: "TEST_IMG_KEY_EMPTY"}
	if _, err := g.ResolveKey(); err == nil {
		t.Fatal("expected empty env error")
	}
}

func TestImportExport(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "image-api-groups.json")
	os.WriteFile(src, []byte(`{
  "default_group": "custom-provider",
  "groups": {
    "default": {"base_url": "https://api.openai.com", "append_v1": true, "api_key_env": "OPENAI_API_KEY", "model": "gpt-image-2"},
    "custom-provider": {"base_url": "https://host.example/v1", "append_v1": false, "api_key": "sk-literal-abcdefgh", "model": "gpt-image-2"}
  }
}`), 0o600)
	f, err := ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	s := NewStore(filepath.Join(dir, "groups.json"))
	n, err := s.Import(f, false)
	if err != nil || n != 2 {
		t.Fatalf("import n=%d err=%v", n, err)
	}
	if def, _, _ := s.Views(); def != "custom-provider" {
		t.Fatalf("default=%s", def)
	}
	out, _ := s.Export(false)
	if out.Groups["custom-provider"].APIKey != "" || out.Groups["default"].APIKeyEnv != "OPENAI_API_KEY" {
		t.Fatal("export without keys wrong")
	}
	out, _ = s.Export(true)
	if out.Groups["custom-provider"].APIKey != "sk-literal-abcdefgh" {
		t.Fatal("export with keys wrong")
	}
	dst := filepath.Join(dir, "codex", "image-api-groups.json")
	if err := WriteFile(dst, out); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(dst)
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("export perm=%v", fi.Mode().Perm())
		}
	}
}
