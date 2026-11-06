package engine

import "testing"

func TestWebpSize(t *testing.T) {
	// VP8X: canvas 300x200 → 存储为 w-1 / h-1
	b := make([]byte, 30)
	copy(b, "RIFF")
	copy(b[8:], "WEBPVP8X")
	w, h := 299, 199
	b[24], b[25], b[26] = byte(w), byte(w>>8), byte(w>>16)
	b[27], b[28], b[29] = byte(h), byte(h>>8), byte(h>>16)
	if gw, gh, ok := webpSize(b); !ok || gw != 300 || gh != 200 {
		t.Fatalf("%d %d %v", gw, gh, ok)
	}
	if _, _, ok := webpSize([]byte("not webp at all, definitely not")); ok {
		t.Fatal("false positive")
	}
}
