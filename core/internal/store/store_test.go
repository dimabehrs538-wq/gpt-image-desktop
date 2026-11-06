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
