// Package models 拉取并缓存各接口分组的模型列表（GET {effectiveBaseUrl}/models）。
//
// 只保留模型 ID 中（不区分大小写）包含 "image" 的条目：这是**名称匹配**，不是能力检测，
// 不会为了探测能力去调用任何付费的生图接口。缓存按分组隔离，并记录分组 baseUrl + 密钥的指纹，
// 接口地址或密钥变化后旧列表不会被错误复用。缓存文件 models.json 以 0600 写入，不含任何密钥。
package models

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/imageapi"
)

// Filter 模型名称筛选关键字（不区分大小写的子串匹配）。
const Filter = "image"

// Timeout 单次拉取超时。
const Timeout = 20 * time.Second

// Dedupe 同一分组在该时间内重复刷新时直接返回刚拉取的结果，不再请求上游。
const Dedupe = 3 * time.Second

// Entry 磁盘上的一条分组缓存。
type Entry struct {
	Fingerprint      string   `json:"fingerprint"`
	EffectiveBaseURL string   `json:"effectiveBaseUrl"`
	Models           []string `json:"models"`
	// Total 为接口返回的不同模型 ID 数（空 id 忽略、重复 id 去重后计数），不是原始 data 数组长度
	Total       int    `json:"total"`
	FetchedAt   int64  `json:"fetchedAt"`
	Error       string `json:"error,omitempty"`
	ErrorStatus int    `json:"errorStatus,omitempty"`
	ErrorAt     int64  `json:"errorAt,omitempty"`
}

type file struct {
	Version int               `json:"version"`
	Groups  map[string]*Entry `json:"groups"`
}

// View 对外返回的分组模型缓存（字段固定，便于 Go / Rust 内核协议逐项比对）。
type View struct {
	Group            string   `json:"group"`
	Models           []string `json:"models"`
	Total            int      `json:"total"`
	FetchedAt        int64    `json:"fetchedAt"`
	EffectiveBaseURL string   `json:"effectiveBaseUrl"`
	Stale            bool     `json:"stale"`
	Error            string   `json:"error"`
	ErrorStatus      int      `json:"errorStatus"`
	ErrorAt          int64    `json:"errorAt"`
	Filter           string   `json:"filter"`
}

// RefreshResult 刷新结果：ok=false 时 message 为失败原因，cache 中保留上次成功的列表。
type RefreshResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
	Cache   View   `json:"cache"`
}

// Fingerprint 由最终请求前缀与密钥计算（截断的 SHA-1，不可逆，仅用于判断端点是否变化）。
func Fingerprint(effBase, key string) string {
	if effBase == "" || key == "" {
		return ""
	}
	h := sha1.Sum([]byte(effBase + "\n" + key))
	return hex.EncodeToString(h[:8])
}

// ParseList 解析标准 OpenAI 模型列表 {"data":[{"id":"..."}]}，返回去重后的全部 ID。
func ParseList(raw []byte) ([]string, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return nil, errors.New("响应不是标准的模型列表 JSON")
	}
	dataRaw, ok := top["data"]
	if !ok {
		return nil, errors.New("响应不是标准的模型列表（缺少 data 数组）")
	}
	var data []json.RawMessage
	if err := json.Unmarshal(dataRaw, &data); err != nil || data == nil {
		return nil, errors.New("响应不是标准的模型列表（data 不是数组）")
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, d := range data {
		var m struct {
			ID any `json:"id"`
		}
		if json.Unmarshal(d, &m) != nil {
			continue
		}
		id, _ := m.ID.(string)
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(data) > 0 && len(ids) == 0 {
		return nil, errors.New("模型列表格式不正确（data 中没有字符串 id）")
	}
	return ids, nil
}

// FilterImage 筛选名称包含 image 的模型（不区分大小写），去重并按名称排序（不区分大小写，相同再按原文）。
func FilterImage(ids []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] || !strings.Contains(strings.ToLower(id), Filter) {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i]), strings.ToLower(out[j])
		if a != b {
			return a < b
		}
		return out[i] < out[j]
	})
	return out
}

// Cache 线程安全的模型缓存（每次读写都落盘，重启后可用）。
type Cache struct {
	path  string
	mu    sync.Mutex // 保护文件读写
	locks sync.Map   // 分组名 → *sync.Mutex，串行化同一分组的刷新
	HTTP  *http.Client
	UA    string
}

// New 创建缓存，path 为 models.json 路径。
func New(path string) *Cache {
	return &Cache{path: path, HTTP: &http.Client{Timeout: Timeout}, UA: "GPTImageStudio/1.0"}
}

// Path 缓存文件路径。
func (c *Cache) Path() string { return c.path }

func (c *Cache) load() *file {
	f := &file{Version: 1, Groups: map[string]*Entry{}}
	raw, err := os.ReadFile(c.path)
	if err == nil {
		_ = json.Unmarshal(raw, f) // 损坏时视为空缓存
	}
	if f.Groups == nil {
		f.Groups = map[string]*Entry{}
	}
	return f
}

func (c *Cache) save(f *file) error {
	f.Version = 1
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), ".models-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_ = tmp.Chmod(0o600)
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), c.path); err != nil {
		return err
	}
	return os.Chmod(c.path, 0o600)
}

func (c *Cache) get(name string) *Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.load().Groups[name]
}

func (c *Cache) put(name string, e *Entry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	f := c.load()
	f.Groups[name] = e
	return c.save(f)
}

// Rename 分组改名时迁移缓存。
func (c *Cache) Rename(from, to string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	f := c.load()
	e := f.Groups[from]
	if e == nil {
		return nil
	}
	delete(f.Groups, from)
	f.Groups[to] = e
	return c.save(f)
}

// Remove 删除分组时清除缓存。
func (c *Cache) Remove(name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	f := c.load()
	if f.Groups[name] == nil {
		return nil
	}
	delete(f.Groups, name)
	return c.save(f)
}

// Current 描述分组当前的端点（用于判断缓存是否过期）。
type Current struct {
	Name             string
	EffectiveBaseURL string
	Fingerprint      string // 密钥解析失败时为空
}

// CurrentOf 从分组配置计算当前端点指纹。
func CurrentOf(name string, g *config.Group) Current {
	eff := config.EffectiveBaseURL(g.BaseURL, g.AppendV1)
	cur := Current{Name: name, EffectiveBaseURL: eff}
	if k, err := g.ResolveKey(); err == nil {
		cur.Fingerprint = Fingerprint(eff, k)
	}
	return cur
}

// ViewOf 生成视图：端点或密钥变化（指纹不一致）时 stale=true 且不返回旧列表。
func ViewOf(cur Current, e *Entry) View {
	v := View{Group: cur.Name, Models: []string{}, EffectiveBaseURL: cur.EffectiveBaseURL, Filter: Filter}
	if e == nil {
		return v
	}
	if e.Fingerprint == "" || e.Fingerprint != cur.Fingerprint {
		v.Stale = e.FetchedAt > 0 || e.Error != ""
		return v
	}
	v.Models = append(v.Models, e.Models...)
	v.Total, v.FetchedAt = e.Total, e.FetchedAt
	v.Error, v.ErrorStatus, v.ErrorAt = e.Error, e.ErrorStatus, e.ErrorAt
	return v
}

// Views 返回全部分组的视图（只包含当前存在的分组）。
func (c *Cache) Views(cfg *config.File) map[string]View {
	c.mu.Lock()
	f := c.load()
	c.mu.Unlock()
	out := map[string]View{}
	for name, g := range cfg.Groups {
		out[name] = ViewOf(CurrentOf(name, g), f.Groups[name])
	}
	return out
}

// View 单个分组视图。
func (c *Cache) View(cur Current) View { return ViewOf(cur, c.get(cur.Name)) }

func (c *Cache) lock(name string) func() {
	m, _ := c.locks.LoadOrStore(name, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// Refresh 拉取分组的模型列表并保存。keyErr 非空表示密钥解析失败（不发请求，只记录错误）。
// 失败时保留上次成功的列表（端点未变化时），并记录错误状态；绝不切换到其它分组。
func (c *Cache) Refresh(ctx context.Context, cur Current, key string, keyErr error) RefreshResult {
	unlock := c.lock(cur.Name)
	defer unlock()
	now := time.Now().UnixMilli()
	old := c.get(cur.Name)
	same := old != nil && old.Fingerprint != "" && old.Fingerprint == cur.Fingerprint
	fail := func(status int, msg string) RefreshResult {
		e := &Entry{Fingerprint: cur.Fingerprint, EffectiveBaseURL: cur.EffectiveBaseURL, Models: []string{}}
		if same {
			cp := *old
			e = &cp
		}
		e.Error, e.ErrorStatus, e.ErrorAt = msg, status, now
		_ = c.put(cur.Name, e)
		return RefreshResult{OK: false, Message: msg, Cache: ViewOf(cur, e)}
	}
	if keyErr != nil {
		return fail(0, keyErr.Error())
	}
	if same && old.Error == "" && old.FetchedAt > 0 && now-old.FetchedAt < Dedupe.Milliseconds() {
		return RefreshResult{OK: true, Message: summary(old), Cache: ViewOf(cur, old)}
	}
	ctx, cancel := context.WithTimeout(ctx, Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cur.EffectiveBaseURL+"/models", nil)
	if err != nil {
		return fail(0, "请求地址不正确："+config.Redact(err.Error(), key))
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("User-Agent", c.UA)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		msg := config.Redact(err.Error(), key)
		if errors.Is(err, context.DeadlineExceeded) || strings.Contains(strings.ToLower(msg), "timeout") {
			return fail(0, fmt.Sprintf("拉取模型列表超时（%d 秒）", int(Timeout.Seconds())))
		}
		return fail(0, "无法连接："+msg)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fail(resp.StatusCode, "读取响应失败："+config.Redact(err.Error(), key))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := imageapi.ParseError(resp.StatusCode, raw, key).Error()
		if resp.StatusCode == 404 || resp.StatusCode == 405 {
			msg += "（该接口可能不支持 GET /models，可直接手动输入模型名）"
		}
		return fail(resp.StatusCode, msg)
	}
	ids, err := ParseList(raw)
	if err != nil {
		return fail(resp.StatusCode, err.Error()+"，可直接手动输入模型名")
	}
	e := &Entry{Fingerprint: cur.Fingerprint, EffectiveBaseURL: cur.EffectiveBaseURL, Models: FilterImage(ids), Total: len(ids), FetchedAt: now}
	if err := c.put(cur.Name, e); err != nil {
		return RefreshResult{OK: false, Message: "保存模型缓存失败：" + err.Error(), Cache: ViewOf(cur, e)}
	}
	return RefreshResult{OK: true, Message: summary(e), Cache: ViewOf(cur, e)}
}

func summary(e *Entry) string {
	if e.Total == 0 {
		return "接口返回的模型列表为空，可直接手动输入模型名"
	}
	if len(e.Models) == 0 {
		return fmt.Sprintf("接口返回 %d 个不同模型（已去重），但名称都不含 image，可直接手动输入模型名", e.Total)
	}
	return fmt.Sprintf("接口返回 %d 个不同模型（已去重），其中 %d 个名称包含 image", e.Total, len(e.Models))
}
