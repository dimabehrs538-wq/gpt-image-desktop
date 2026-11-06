// Package config 管理生图接口分组（兼容 ~/.codex/image-api-groups.json 格式）。
//
// 配置文件以 0600 权限落盘；任何对外输出（API / 日志）都只给出脱敏后的密钥。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// KeyRef 指向另一个 JSON 文件中的密钥字段（field 支持 a.b.c 点号路径）。
type KeyRef struct {
	Path  string `json:"path"`
	Field string `json:"field"`
}

// Group 一个接口分组，字段名与 openai-image-api 技能保持一致。
type Group struct {
	BaseURL     string  `json:"base_url"`
	AppendV1    bool    `json:"append_v1"`
	APIKey      string  `json:"api_key,omitempty"`
	APIKeyEnv   string  `json:"api_key_env,omitempty"`
	APIKeyRef   *KeyRef `json:"api_key_ref,omitempty"`
	Model       string  `json:"model"`
	DisplayName string  `json:"display_name,omitempty"`
	Note        string  `json:"note,omitempty"`
	CreatedAt   int64   `json:"created_at,omitempty"`
}

// File 配置文件根对象。
type File struct {
	DefaultGroup string            `json:"default_group"`
	Groups       map[string]*Group `json:"groups"`
	// 以下字段为技能脚本自身使用的可选项，导入后原样保留
	ImagegenScript string `json:"imagegen_script,omitempty"`
	Python         string `json:"python,omitempty"`
}

// DefaultModel 未指定模型时使用的默认模型。
const DefaultModel = "gpt-image-2"

var nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// ValidName 分组名：字母数字开头，可含 . _ -，最长 64。
func ValidName(n string) bool { return nameRe.MatchString(n) }

// EffectiveBaseURL 规范化最终请求前缀：去掉末尾 /；append_v1 开启或官方域名未带路径时补 /v1，已以 /v1 结尾则不重复。
func EffectiveBaseURL(base string, appendV1 bool) string {
	b := strings.TrimSpace(base)
	b = strings.TrimRight(b, "/")
	if b == "" {
		return ""
	}
	if !strings.HasSuffix(b, "/v1") {
		if appendV1 {
			b += "/v1"
		} else if u, err := url.Parse(b); err == nil && strings.EqualFold(u.Hostname(), "api.openai.com") && (u.Path == "" || u.Path == "/") {
			b += "/v1"
		}
	}
	return b
}

// ValidateBaseURL 检查 baseUrl 是否为 http(s) 绝对地址。
func ValidateBaseURL(base string) error {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("baseUrl 必须是 http:// 或 https:// 开头的完整地址")
	}
	return nil
}

// MaskKey 脱敏密钥，例如 sk-••••abcd。
func MaskKey(k string) string {
	k = strings.TrimSpace(k)
	if k == "" {
		return ""
	}
	if len(k) <= 8 {
		return "••••"
	}
	prefix := ""
	if i := strings.Index(k, "-"); i > 0 && i <= 4 {
		prefix = k[:i+1]
	}
	return prefix + "••••" + k[len(k)-4:]
}

var skRe = regexp.MustCompile(`(sk|ak|key)-[A-Za-z0-9_\-]{8,}`)
var bearerRe = regexp.MustCompile(`(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}`)

// Redact 从任意文本中抹去密钥（精确匹配 + 常见 sk- / Bearer 形式）。
func Redact(s string, keys ...string) string {
	for _, k := range keys {
		if len(k) >= 4 {
			s = strings.ReplaceAll(s, k, MaskKey(k))
		}
	}
	s = skRe.ReplaceAllStringFunc(s, MaskKey)
	s = bearerRe.ReplaceAllString(s, "${1}••••")
	return s
}

// KeySource 返回密钥来源：env / literal / ref / none（与技能脚本的解析优先级一致）。
func (g *Group) KeySource() string {
	switch {
	case g.APIKeyEnv != "":
		return "env"
	case g.APIKey != "":
		return "literal"
	case g.APIKeyRef != nil && g.APIKeyRef.Path != "":
		return "ref"
	}
	return "none"
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, p[1:])
		}
	}
	return p
}

// ResolveKey 按 api_key_env → api_key → api_key_ref 顺序解析密钥。错误信息不含密钥。
func (g *Group) ResolveKey() (string, error) {
	if g.APIKeyEnv != "" {
		v := os.Getenv(g.APIKeyEnv)
		if v == "" {
			return "", fmt.Errorf("环境变量 %s 为空，未能读取 API Key", g.APIKeyEnv)
		}
		return v, nil
	}
	if g.APIKey != "" {
		return g.APIKey, nil
	}
	if g.APIKeyRef == nil || g.APIKeyRef.Path == "" {
		return "", errors.New("该分组未配置 API Key（api_key / api_key_env / api_key_ref 均为空）")
	}
	raw, err := os.ReadFile(expandHome(g.APIKeyRef.Path))
	if err != nil {
		return "", fmt.Errorf("无法读取 api_key_ref 文件 %s：%v", g.APIKeyRef.Path, err)
	}
	var data any
	if err := json.Unmarshal(raw, &data); err != nil {
		return "", fmt.Errorf("api_key_ref 文件不是合法 JSON：%s", g.APIKeyRef.Path)
	}
	cur := data
	for _, c := range strings.Split(g.APIKeyRef.Field, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return "", fmt.Errorf("api_key_ref 字段不存在：%s", g.APIKeyRef.Field)
		}
		if cur, ok = m[c]; !ok {
			return "", fmt.Errorf("api_key_ref 字段不存在：%s", g.APIKeyRef.Field)
		}
	}
	s, ok := cur.(string)
	if !ok || s == "" {
		return "", fmt.Errorf("api_key_ref 字段为空：%s", g.APIKeyRef.Field)
	}
	return s, nil
}

// GroupView 对外展示的分组（密钥已脱敏）。
type GroupView struct {
	Name             string  `json:"name"`
	DisplayName      string  `json:"displayName"`
	Note             string  `json:"note"`
	BaseURL          string  `json:"baseUrl"`
	AppendV1         bool    `json:"appendV1"`
	Model            string  `json:"model"`
	KeySource        string  `json:"keySource"`
	KeyMask          string  `json:"keyMask"`
	KeyEnv           string  `json:"keyEnv,omitempty"`
	KeyRef           *KeyRef `json:"keyRef,omitempty"`
	KeyOK            bool    `json:"keyOk"`
	KeyError         string  `json:"keyError,omitempty"`
	EffectiveBaseURL string  `json:"effectiveBaseUrl"`
	GenerationsURL   string  `json:"generationsUrl"`
	EditsURL         string  `json:"editsUrl"`
	IsDefault        bool    `json:"isDefault"`
	CreatedAt        int64   `json:"createdAt"`
}

// View 生成脱敏视图。
func (g *Group) View(name string, isDefault bool) GroupView {
	eff := EffectiveBaseURL(g.BaseURL, g.AppendV1)
	v := GroupView{
		Name: name, DisplayName: g.DisplayName, Note: g.Note, BaseURL: g.BaseURL, AppendV1: g.AppendV1,
		Model: g.Model, KeySource: g.KeySource(), KeyEnv: g.APIKeyEnv, KeyRef: g.APIKeyRef,
		EffectiveBaseURL: eff, GenerationsURL: eff + "/images/generations", EditsURL: eff + "/images/edits",
		IsDefault: isDefault, CreatedAt: g.CreatedAt,
	}
	if v.Model == "" {
		v.Model = DefaultModel
	}
	if k, err := g.ResolveKey(); err != nil {
		v.KeyError = err.Error()
	} else {
		v.KeyOK = true
		v.KeyMask = MaskKey(k)
	}
	return v
}

// Store 线程安全的分组配置存储（每次操作都从磁盘重新读取，便于 CLI 与守护进程共用）。
type Store struct {
	mu   sync.Mutex
	path string
}

// NewStore 创建存储，path 为 groups.json 路径。
func NewStore(path string) *Store { return &Store{path: path} }

// Path 配置文件路径。
func (s *Store) Path() string { return s.path }

// ReadFile 解析一个分组配置文件。
func ReadFile(path string) (*File, error) {
	raw, err := os.ReadFile(expandHome(path))
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("配置文件不是合法 JSON：%v", err)
	}
	if f.Groups == nil {
		f.Groups = map[string]*Group{}
	}
	return &f, nil
}

// WriteFile 原子写入配置文件，权限 0600。
func WriteFile(path string, f *File) error {
	path = expandHome(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".groups-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !isWindows() {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
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

func (s *Store) load() (*File, error) {
	f, err := ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return &File{Groups: map[string]*Group{}}, nil
	}
	return f, err
}

// Load 读取当前配置（返回副本，调用方可随意修改）。
func (s *Store) Load() (*File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Update 在锁内读取 → 修改 → 写回。
func (s *Store) Update(fn func(f *File) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	f, err := s.load()
	if err != nil {
		return err
	}
	if err := fn(f); err != nil {
		return err
	}
	if f.DefaultGroup == "" || f.Groups[f.DefaultGroup] == nil {
		f.DefaultGroup = ""
		for _, n := range SortedNames(f) {
			f.DefaultGroup = n
			break
		}
	}
	return WriteFile(s.path, f)
}

// SortedNames 按创建时间、名称排序的分组名。
func SortedNames(f *File) []string {
	names := make([]string, 0, len(f.Groups))
	for n := range f.Groups {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool {
		a, b := f.Groups[names[i]], f.Groups[names[j]]
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt < b.CreatedAt
		}
		return names[i] < names[j]
	})
	return names
}

// Views 返回全部分组的脱敏视图。
func (s *Store) Views() (string, []GroupView, error) {
	f, err := s.Load()
	if err != nil {
		return "", nil, err
	}
	out := []GroupView{}
	for _, n := range SortedNames(f) {
		out = append(out, f.Groups[n].View(n, n == f.DefaultGroup))
	}
	return f.DefaultGroup, out, nil
}

// Endpoint 解析后的请求端点（含明文密钥，仅在内存中使用）。
type Endpoint struct {
	Group   string
	BaseURL string
	Key     string
	Model   string
}

// Resolve 解析指定分组（为空则用默认分组）。严格不回退到其它分组。
func (s *Store) Resolve(name string) (*Endpoint, error) {
	f, err := s.Load()
	if err != nil {
		return nil, err
	}
	if name == "" {
		name = os.Getenv("IMAGE_API_GROUP")
	}
	if name == "" {
		name = f.DefaultGroup
	}
	g := f.Groups[name]
	if name == "" || g == nil {
		return nil, fmt.Errorf("接口分组不存在：%q，请先在「接口配置」中创建", name)
	}
	if err := ValidateBaseURL(g.BaseURL); err != nil {
		return nil, fmt.Errorf("分组 %s：%v", name, err)
	}
	key, err := g.ResolveKey()
	if err != nil {
		return nil, fmt.Errorf("分组 %s：%v", name, err)
	}
	model := g.Model
	if model == "" {
		model = DefaultModel
	}
	return &Endpoint{Group: name, BaseURL: EffectiveBaseURL(g.BaseURL, g.AppendV1), Key: key, Model: model}, nil
}

// Input 创建 / 更新分组的入参。APIKey 为空表示保持原密钥。
type Input struct {
	Name        string  `json:"name"`
	NewName     string  `json:"newName,omitempty"`
	DisplayName string  `json:"displayName"`
	Note        string  `json:"note"`
	BaseURL     string  `json:"baseUrl"`
	AppendV1    bool    `json:"appendV1"`
	Model       string  `json:"model"`
	KeySource   string  `json:"keySource"` // literal / env / ref
	APIKey      string  `json:"apiKey"`
	APIKeyEnv   string  `json:"apiKeyEnv"`
	APIKeyRef   *KeyRef `json:"apiKeyRef"`
	MakeDefault bool    `json:"makeDefault"`
}

func applyInput(g *Group, in Input, creating bool) error {
	if err := ValidateBaseURL(in.BaseURL); err != nil {
		return err
	}
	g.BaseURL = strings.TrimSpace(in.BaseURL)
	g.AppendV1 = in.AppendV1
	g.Model = strings.TrimSpace(in.Model)
	if g.Model == "" {
		g.Model = DefaultModel
	}
	g.DisplayName = strings.TrimSpace(in.DisplayName)
	g.Note = strings.TrimSpace(in.Note)
	src := in.KeySource
	if src == "" {
		src = "literal"
	}
	switch src {
	case "literal":
		k := strings.TrimSpace(in.APIKey)
		if k == "" && (creating || g.APIKey == "") {
			return errors.New("请填写 API Key")
		}
		if k != "" {
			g.APIKey = k
		}
		g.APIKeyEnv, g.APIKeyRef = "", nil
	case "env":
		if strings.TrimSpace(in.APIKeyEnv) == "" {
			return errors.New("请填写保存 API Key 的环境变量名")
		}
		g.APIKeyEnv, g.APIKey, g.APIKeyRef = strings.TrimSpace(in.APIKeyEnv), "", nil
	case "ref":
		if in.APIKeyRef == nil || in.APIKeyRef.Path == "" || in.APIKeyRef.Field == "" {
			return errors.New("请填写 api_key_ref 的文件路径与字段")
		}
		g.APIKeyRef, g.APIKey, g.APIKeyEnv = in.APIKeyRef, "", ""
	default:
		return fmt.Errorf("未知的密钥来源：%s", src)
	}
	return nil
}

// Create 新建分组。
func (s *Store) Create(in Input) error {
	in.Name = strings.TrimSpace(in.Name)
	if !ValidName(in.Name) {
		return errors.New("分组标识只能包含字母、数字、. _ -，且以字母或数字开头（最长 64）")
	}
	return s.Update(func(f *File) error {
		if f.Groups[in.Name] != nil {
			return fmt.Errorf("分组 %s 已存在", in.Name)
		}
		g := &Group{CreatedAt: time.Now().UnixMilli()}
		if err := applyInput(g, in, true); err != nil {
			return err
		}
		f.Groups[in.Name] = g
		if in.MakeDefault || len(f.Groups) == 1 {
			f.DefaultGroup = in.Name
		}
		return nil
	})
}

// Modify 更新分组，可通过 NewName 重命名。
func (s *Store) Modify(name string, in Input) error {
	return s.Update(func(f *File) error {
		g := f.Groups[name]
		if g == nil {
			return fmt.Errorf("分组不存在：%s", name)
		}
		cp := *g
		if err := applyInput(&cp, in, false); err != nil {
			return err
		}
		target := name
		if nn := strings.TrimSpace(in.NewName); nn != "" && nn != name {
			if !ValidName(nn) {
				return errors.New("新的分组标识不合法")
			}
			if f.Groups[nn] != nil {
				return fmt.Errorf("分组 %s 已存在", nn)
			}
			delete(f.Groups, name)
			if f.DefaultGroup == name {
				f.DefaultGroup = nn
			}
			target = nn
		}
		f.Groups[target] = &cp
		if in.MakeDefault {
			f.DefaultGroup = target
		}
		return nil
	})
}

// Delete 删除分组。
func (s *Store) Delete(name string) error {
	return s.Update(func(f *File) error {
		if f.Groups[name] == nil {
			return fmt.Errorf("分组不存在：%s", name)
		}
		delete(f.Groups, name)
		if f.DefaultGroup == name {
			f.DefaultGroup = ""
		}
		return nil
	})
}

// SetDefault 设为默认分组。
func (s *Store) SetDefault(name string) error {
	return s.Update(func(f *File) error {
		if f.Groups[name] == nil {
			return fmt.Errorf("分组不存在：%s", name)
		}
		f.DefaultGroup = name
		return nil
	})
}

// CodexConfigPath 返回 $CODEX_HOME/image-api-groups.json（默认 ~/.codex）。
func CodexConfigPath() string {
	dir := os.Getenv("CODEX_HOME")
	if dir == "" {
		h, _ := os.UserHomeDir()
		dir = filepath.Join(h, ".codex")
	}
	return filepath.Join(expandHome(dir), "image-api-groups.json")
}

// Import 从外部配置合并（merge）或替换（replace）。返回导入的分组数。
func (s *Store) Import(src *File, replace bool) (int, error) {
	n := 0
	err := s.Update(func(f *File) error {
		if replace {
			f.Groups = map[string]*Group{}
			f.DefaultGroup = ""
		}
		now := time.Now().UnixMilli()
		for _, name := range SortedNames(src) {
			g := src.Groups[name]
			if g == nil || !ValidName(name) {
				continue
			}
			cp := *g
			if cp.CreatedAt == 0 {
				cp.CreatedAt = now + int64(n)
			}
			if cp.Model == "" {
				cp.Model = DefaultModel
			}
			f.Groups[name] = &cp
			n++
		}
		if src.DefaultGroup != "" && f.Groups[src.DefaultGroup] != nil && (replace || f.DefaultGroup == "") {
			f.DefaultGroup = src.DefaultGroup
		}
		if src.ImagegenScript != "" {
			f.ImagegenScript = src.ImagegenScript
		}
		if src.Python != "" {
			f.Python = src.Python
		}
		return nil
	})
	return n, err
}

// Export 导出为技能兼容格式。includeKeys=false 时去掉明文 api_key（env / ref 引用保留）。
func (s *Store) Export(includeKeys bool) (*File, error) {
	f, err := s.Load()
	if err != nil {
		return nil, err
	}
	out := &File{DefaultGroup: f.DefaultGroup, Groups: map[string]*Group{}, ImagegenScript: f.ImagegenScript, Python: f.Python}
	for n, g := range f.Groups {
		cp := *g
		if !includeKeys {
			cp.APIKey = ""
		}
		out.Groups[n] = &cp
	}
	return out, nil
}
