// Package rotlog 按大小轮换的日志文件写入器（imagegend.log → .1 → .2 …）。
package rotlog

import (
	"fmt"
	"os"
	"sync"
)

// Writer 线程安全的轮换日志。
type Writer struct {
	mu      sync.Mutex
	path    string
	max     int64
	backups int
	f       *os.File
	size    int64
}

// Open 打开日志，maxBytes 达到后轮换，保留 backups 个旧文件。
func Open(path string, maxBytes int64, backups int) (*Writer, error) {
	w := &Writer{path: path, max: maxBytes, backups: backups}
	return w, w.open()
}

func (w *Writer) open() error {
	f, err := os.OpenFile(w.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	fi, _ := f.Stat()
	w.f = f
	if fi != nil {
		w.size = fi.Size()
	}
	return nil
}

func (w *Writer) rotate() error {
	w.f.Close()
	for i := w.backups - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", w.path, i), fmt.Sprintf("%s.%d", w.path, i+1))
	}
	if w.backups > 0 {
		_ = os.Rename(w.path, w.path+".1")
	} else {
		_ = os.Remove(w.path)
	}
	w.size = 0
	return w.open()
}

// Write 实现 io.Writer。
func (w *Writer) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.max > 0 && w.size+int64(len(p)) > w.max {
		if err := w.rotate(); err != nil {
			return 0, err
		}
	}
	n, err := w.f.Write(p)
	w.size += int64(n)
	return n, err
}

// Close 关闭文件。
func (w *Writer) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}
