package thumb

import (
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestThumb(t *testing.T) {
	dir := t.TempDir()
	img := image.NewRGBA(image.Rect(0, 0, 400, 200))
	for i := range img.Pix {
		img.Pix[i] = 200
	}
	img.Set(0, 0, color.Black)
	src := filepath.Join(dir, "a.png")
	f, _ := os.Create(src)
	png.Encode(f, img)
	f.Close()
	out, err := Get(filepath.Join(dir, "cache"), src, 100)
	if err != nil {
		t.Fatal(err)
	}
	g, _ := os.Open(out)
	defer g.Close()
	ti, err := jpeg.Decode(g)
	if err != nil || ti.Bounds().Dx() != 100 || ti.Bounds().Dy() != 50 {
		t.Fatalf("thumb %v %v", ti.Bounds(), err)
	}
	if out2, _ := Get(filepath.Join(dir, "cache"), src, 100); out2 != out {
		t.Fatal("cache miss")
	}
}
