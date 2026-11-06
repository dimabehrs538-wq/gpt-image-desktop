package rotlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRotate(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.log")
	w, err := Open(p, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		w.Write([]byte(strings.Repeat("a", 40) + "\n"))
	}
	w.Close()
	for _, f := range []string{p, p + ".1", p + ".2"} {
		if _, err := os.Stat(f); err != nil {
			t.Fatalf("%s missing", f)
		}
	}
	if _, err := os.Stat(p + ".3"); err == nil {
		t.Fatal("too many backups")
	}
}
