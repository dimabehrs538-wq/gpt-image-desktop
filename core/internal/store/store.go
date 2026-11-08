// Package store 持久化系统设置与作品历史（JSON 文件，原子写入）。
package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Settings 系统设置。
type Settings struct {
	OutputDir         string `json:"outputDir"`
	RequestTimeoutSec int    `json:"requestTimeoutSec"`
	FilenamePrefix    string `json:"filenamePrefix"`
	// MissingPolicy 接口返回张数少于请求时：report（默认）只发 1 次请求并如实报告；fill（需用户主动开启）逐张补请求，总请求数不超过请求张数
	MissingPolicy string `json:"missingPolicy"`
}

// 张数不足时的处理方式。
const (
	MissingFill   = "fill"
	MissingReport = "report"
)

// Item 一张生成结果的历史记录。
type Item struct {
	ID            string   `json:"id"`
	JobID         string   `json:"jobId"`
	CreatedAt     int64    `json:"createdAt"`
	Mode          string   `json:"mode"` // generate / edit
	Group         string   `json:"group"`
	BaseURL       string   `json:"baseUrl"`
	Model         string   `json:"model"`
	Prompt        string   `json:"prompt"`
	RevisedPrompt string   `json:"revisedPrompt,omitempty"`
	Size          string   `json:"size,omitempty"`
	Quality       string   `json:"quality,omitempty"`
	Background    string   `json:"background,omitempty"`
	OutputFormat  string   `json:"outputFormat,omitempty"`
	N             int      `json:"n"`
	Index         int      `json:"index"`
	Path          string   `json:"path"`
	FileSize      int64    `json:"fileSize"`
	Width         int      `json:"width,omitempty"`
	Height        int      `json:"height,omitempty"`
	ElapsedMs     int64    `json:"elapsedMs"`
	SourceURL     string   `json:"sourceUrl,omitempty"`
	InputImages   []string `json:"inputImages,omitempty"`
	Mask          string   `json:"mask,omitempty"`
}

// Store 设置与历史存储。
type Store struct {
	mu         sync.Mutex
	dir        string
	defaultOut string
}

// New dir 为数据目录，defaultOut 为默认输出目录。
func New(dir, defaultOut string) *Store { return &Store{dir: dir, defaultOut: defaultOut} }

// Dir 数据目录。
func (s *Store) Dir() string { return s.dir }

func writeJSON(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func readJSON(path string, v any) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, v)
}

// Settings 读取设置（缺省值补齐）。
func (s *Store) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings()
}

func (s *Store) settings() Settings {
	var st Settings
	_ = readJSON(filepath.Join(s.dir, "settings.json"), &st)
	if st.OutputDir == "" {
		st.OutputDir = s.defaultOut
	}
	if st.RequestTimeoutSec <= 0 {
		st.RequestTimeoutSec = 600
	}
	// 默认（新安装 / 旧配置缺少字段 / 非法值）= report：只发 1 次请求并如实标记 partial；
	// fill 会产生额外请求（按次计费可能多计费），只能由用户在设置中主动开启
	if st.MissingPolicy != MissingFill {
		st.MissingPolicy = MissingReport
	}
	return st
}

// SettingsPatch 部分更新。
type SettingsPatch struct {
	OutputDir         *string `json:"outputDir"`
	RequestTimeoutSec *int    `json:"requestTimeoutSec"`
	FilenamePrefix    *string `json:"filenamePrefix"`
	MissingPolicy     *string `json:"missingPolicy"`
}

// UpdateSettings 应用部分更新。
func (s *Store) UpdateSettings(p SettingsPatch) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.settings()
	if p.OutputDir != nil {
		d := strings.TrimSpace(*p.OutputDir)
		if d == "" {
			d = s.defaultOut
		}
		if !filepath.IsAbs(d) {
			return st, errors.New("输出目录必须是绝对路径")
		}
		if err := os.MkdirAll(d, 0o755); err != nil {
			return st, errors.New("无法创建输出目录：" + err.Error())
		}
		st.OutputDir = d
	}
	if p.RequestTimeoutSec != nil {
		if *p.RequestTimeoutSec < 10 || *p.RequestTimeoutSec > 3600 {
			return st, errors.New("请求超时需在 10–3600 秒之间")
		}
		st.RequestTimeoutSec = *p.RequestTimeoutSec
	}
	if p.FilenamePrefix != nil {
		st.FilenamePrefix = strings.TrimSpace(*p.FilenamePrefix)
	}
	if p.MissingPolicy != nil {
		if *p.MissingPolicy != MissingFill && *p.MissingPolicy != MissingReport {
			return st, errors.New("张数不足处理方式只能是 fill 或 report")
		}
		st.MissingPolicy = *p.MissingPolicy
	}
	return st, writeJSON(filepath.Join(s.dir, "settings.json"), st)
}

func (s *Store) historyPath() string { return filepath.Join(s.dir, "history.json") }

func (s *Store) loadHistory() []Item {
	var items []Item
	_ = readJSON(s.historyPath(), &items)
	return items
}

// AddItems 追加记录。
func (s *Store) AddItems(items ...Item) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := append(s.loadHistory(), items...)
	return writeJSON(s.historyPath(), all)
}

// Query 历史查询条件。
type Query struct {
	Q     string
	Mode  string
	Group string
	Limit int
}

// List 按时间倒序返回匹配记录与总数。
func (s *Store) List(q Query) ([]Item, int) {
	s.mu.Lock()
	all := s.loadHistory()
	s.mu.Unlock()
	kw := strings.ToLower(strings.TrimSpace(q.Q))
	out := []Item{}
	for _, it := range all {
		if q.Mode != "" && it.Mode != q.Mode {
			continue
		}
		if q.Group != "" && it.Group != q.Group {
			continue
		}
		if kw != "" && !strings.Contains(strings.ToLower(it.Prompt+"\n"+it.RevisedPrompt+"\n"+it.Model+"\n"+filepath.Base(it.Path)), kw) {
			continue
		}
		out = append(out, it)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].Index < out[j].Index
	})
	total := len(out)
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, total
}

// Get 按 ID 查询。
func (s *Store) Get(id string) (Item, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.loadHistory() {
		if it.ID == id {
			return it, true
		}
	}
	return Item{}, false
}

// Delete 删除记录；deleteFile 为 true 时同时删除本地图片。
func (s *Store) Delete(id string, deleteFile bool) (Item, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	all := s.loadHistory()
	for i, it := range all {
		if it.ID != id {
			continue
		}
		if deleteFile && it.Path != "" {
			if err := os.Remove(it.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return it, errors.New("删除图片文件失败：" + err.Error())
			}
		}
		all = append(all[:i], all[i+1:]...)
		return it, writeJSON(s.historyPath(), all)
	}
	return Item{}, errors.New("记录不存在")
}

// KnownPath 判断路径是否属于历史记录（输出图或输入图）。
func (s *Store) KnownPath(p string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.loadHistory() {
		if it.Path == p || it.Mask == p {
			return true
		}
		for _, in := range it.InputImages {
			if in == p {
				return true
			}
		}
	}
	return false
}

// Groups 历史中出现过的分组名。
func (s *Store) Groups() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	set := map[string]bool{}
	for _, it := range s.loadHistory() {
		set[it.Group] = true
	}
	out := []string{}
	for g := range set {
		out = append(out, g)
	}
	sort.Strings(out)
	return out
}
