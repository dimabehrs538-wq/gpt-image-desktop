// Package thumb 用标准库生成 JPEG 缩略图并缓存（PNG / JPEG / GIF；其它格式回退原图）。
package thumb

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
)

// Get 返回缩略图路径；无法解码时返回 ("", err)。
func Get(cacheDir, src string, maxSide int) (string, error) {
	fi, err := os.Stat(src)
	if err != nil {
		return "", err
	}
	if maxSide < 64 {
		maxSide = 64
	}
	if maxSide > 1024 {
		maxSide = 1024
	}
	h := sha1.Sum([]byte(fmt.Sprintf("%s|%d|%d|%d", src, fi.Size(), fi.ModTime().UnixNano(), maxSide)))
	out := filepath.Join(cacheDir, hex.EncodeToString(h[:])+".jpg")
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return "", err
	}
	dst := Scale(img, maxSide)
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(cacheDir, ".thumb-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := jpeg.Encode(tmp, dst, &jpeg.Options{Quality: 85}); err != nil {
		tmp.Close()
		return "", err
	}
	tmp.Close()
	return out, os.Rename(tmp.Name(), out)
}

// Scale 按最长边等比缩小（区域平均），透明部分铺白底。
func Scale(src image.Image, maxSide int) *image.RGBA {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	dw, dh := sw, sh
	if sw >= sh && sw > maxSide {
		dw, dh = maxSide, max(1, sh*maxSide/sw)
	} else if sh > sw && sh > maxSide {
		dw, dh = max(1, sw*maxSide/sh), maxSide
	}
	flat := image.NewRGBA(b)
	draw.Draw(flat, b, &image.Uniform{color.White}, image.Point{}, draw.Src)
	draw.Draw(flat, b, src, b.Min, draw.Over)
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		y0, y1 := y*sh/dh, max((y+1)*sh/dh, y*sh/dh+1)
		for x := 0; x < dw; x++ {
			x0, x1 := x*sw/dw, max((x+1)*sw/dw, x*sw/dw+1)
			var r, g, bl, n uint64
			for yy := y0; yy < y1; yy++ {
				off := flat.PixOffset(b.Min.X+x0, b.Min.Y+yy)
				for xx := x0; xx < x1; xx++ {
					r += uint64(flat.Pix[off])
					g += uint64(flat.Pix[off+1])
					bl += uint64(flat.Pix[off+2])
					off += 4
					n++
				}
			}
			o := dst.PixOffset(x, y)
			dst.Pix[o], dst.Pix[o+1], dst.Pix[o+2], dst.Pix[o+3] = uint8(r/n), uint8(g/n), uint8(bl/n), 255
		}
	}
	return dst
}
