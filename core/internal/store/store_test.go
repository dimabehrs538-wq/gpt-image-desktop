package store

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestHistoryAndSettings(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, filepath.Join(dir, "out"))
	if s.Settings().OutputDir != filepath.Join(dir, "out") || s.Settings().RequestTimeoutSec != 600 {
		t.Fatal("defaults")
	}
	rel := "relative/path"
	if _, err := s.UpdateSettings(SettingsPatch{OutputDir: &rel}); err == nil {
		t.Fatal("relative dir should fail")
	}
	img := filepath.Join(dir, "a.png")
	os.WriteFile(img, []byte("x"), 0o644)
	s.AddItems(Item{ID: "1", CreatedAt: 1, Mode: "generate", Group: "a", Prompt: "Red Cat", Path: img},
		Item{ID: "2", CreatedAt: 2, Mode: "edit", Group: "b", Prompt: "blue dog", InputImages: []string{"/in.png"}})
	items, total := s.List(Query{})
	if total != 2 || items[0].ID != "2" {
		t.Fatalf("order %+v", items)
	}
	if _, total := s.List(Query{Q: "cat"}); total != 1 {
		t.Fatal("keyword")
	}
	if _, total := s.List(Query{Mode: "edit", Group: "b"}); total != 1 {
		t.Fatal("filters")
	}
	if !s.KnownPath("/in.png") || s.KnownPath("/other.png") {
		t.Fatal("known path")
	}
	if _, err := s.Delete("1", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(img); !os.IsNotExist(err) {
		t.Fatal("file should be deleted")
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(dir, "history.json"))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("perm %v", fi.Mode().Perm())
		}
	}
}

func TestMissingPolicyDefaultReport(t *testing.T) {
	dir := t.TempDir()
	s := New(dir, filepath.Join(dir, "out"))
	if got := s.Settings().MissingPolicy; got != MissingReport {
		t.Fatalf("new install policy=%q, want report", got)
	}
	// 旧配置缺少字段、或字段为空 / 未知值：一律按 report，不自动迁移为 fill
	for _, raw := range []string{`{"filenamePrefix":"x"}`, `{"missingPolicy":""}`, `{"missingPolicy":"auto"}`} {
		if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := s.Settings().MissingPolicy; got != MissingReport {
			t.Fatalf("%s → %q, want report", raw, got)
		}
	}
	bad := "forever"
	if _, err := s.UpdateSettings(SettingsPatch{MissingPolicy: &bad}); err == nil {
		t.Fatal("invalid policy accepted")
	}
	fill := MissingFill
	if st, err := s.UpdateSettings(SettingsPatch{MissingPolicy: &fill}); err != nil || st.MissingPolicy != MissingFill {
		t.Fatalf("enable fill: %v %v", st.MissingPolicy, err)
	}
	// 其它设置更新不改动用户的明确选择
	p := "y"
	if st, _ := s.UpdateSettings(SettingsPatch{FilenamePrefix: &p}); st.MissingPolicy != MissingFill {
		t.Fatalf("policy reset to %q", st.MissingPolicy)
	}
	if got := s.Settings().MissingPolicy; got != MissingFill {
		t.Fatalf("persisted policy=%q", got)
	}
}
