package imageapi

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// ExtFor 根据实际内容（优先）或 output_format 推断扩展名。
func ExtFor(data []byte, outputFormat string) string {
	switch http.DetectContentType(data) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	}
	switch strings.ToLower(outputFormat) {
	case "jpeg", "jpg":
		return ".jpg"
	case "webp":
		return ".webp"
	}
	return ".png"
}

var unsafeRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// SafeBase 把任意字符串转成安全的 ASCII 文件名前缀。
func SafeBase(s string) string {
	s = unsafeRe.ReplaceAllString(strings.TrimSpace(s), "-")
	s = strings.Trim(s, "-.")
	if len(s) > 48 {
		s = strings.TrimRight(s[:48], "-.")
	}
	return s
}

// SaveNoOverwrite 以 O_EXCL 写入 dir/base+ext；同名已存在时依次尝试 base-2、base-3…，绝不覆盖。
func SaveNoOverwrite(dir, base, ext string, data []byte) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	if base == "" {
		base = "image"
	}
	for i := 1; i < 100000; i++ {
		name := base + ext
		if i > 1 {
			name = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		p := filepath.Join(dir, name)
		f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		if _, err := f.Write(data); err != nil {
			f.Close()
			os.Remove(p)
			return "", err
		}
		return p, f.Close()
	}
	return "", errors.New("无法找到可用的文件名")
}
