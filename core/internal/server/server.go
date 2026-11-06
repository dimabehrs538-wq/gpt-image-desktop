// Package server 提供仅监听 127.0.0.1、Bearer Token 鉴权的本地 HTTP API 与 SSE 事件流。
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/engine"
	"github.com/gpt-image-desktop/core/internal/imageapi"
	"github.com/gpt-image-desktop/core/internal/store"
	"github.com/gpt-image-desktop/core/internal/thumb"
)

// Version 内核版本。
var Version = "0.1.0"

// Job 异步生图任务。
type Job struct {
	ID         string       `json:"id"`
	Mode       string       `json:"mode"`
	Status     string       `json:"status"` // running / succeeded / failed / canceled
	Group      string       `json:"group"`
	Model      string       `json:"model"`
	Prompt     string       `json:"prompt"`
	Size       string       `json:"size,omitempty"`
	N          int          `json:"n"`
	InputCount int          `json:"inputCount"`
	CreatedAt  int64        `json:"createdAt"`
	FinishedAt int64        `json:"finishedAt,omitempty"`
	ElapsedMs  int64        `json:"elapsedMs"`
	Error      string       `json:"error,omitempty"`
	Items      []store.Item `json:"items"`
	cancel     context.CancelFunc
}

// Event SSE 事件。
type Event struct {
	Type string `json:"type"` // hello / job / history / groups / settings
	Data any    `json:"data,omitempty"`
	Time int64  `json:"time"`
}

// Server 本地 API 服务。
type Server struct {
	Token  string
	Engine *engine.Engine
	Log    *log.Logger
	start  time.Time

	mu   sync.Mutex
	jobs map[string]*Job
	subs map[chan Event]struct{}
	sem  chan struct{}
}

// New 创建服务。
func New(token string, e *engine.Engine, lg *log.Logger) *Server {
	if lg == nil {
		lg = log.New(os.Stderr, "", log.LstdFlags)
	}
	return &Server{Token: token, Engine: e, Log: lg, start: time.Now(), jobs: map[string]*Job{}, subs: map[chan Event]struct{}{}, sem: make(chan struct{}, 4)}
}

// Handler 返回带鉴权与 CORS 的路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/status", s.status)
	mux.HandleFunc("GET /api/events", s.events)
	mux.HandleFunc("GET /api/groups", s.listGroups)
	mux.HandleFunc("POST /api/groups", s.createGroup)
	mux.HandleFunc("POST /api/groups/preview", s.previewGroup)
	mux.HandleFunc("POST /api/groups/import", s.importGroups)
	mux.HandleFunc("GET /api/groups/export", s.exportGroups)
	mux.HandleFunc("POST /api/groups/export", s.exportGroupsToFile)
	mux.HandleFunc("PUT /api/groups/{name}", s.updateGroup)
	mux.HandleFunc("DELETE /api/groups/{name}", s.deleteGroup)
	mux.HandleFunc("POST /api/groups/{name}/default", s.defaultGroup)
	mux.HandleFunc("POST /api/groups/{name}/test", s.testGroup)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("PUT /api/settings", s.putSettings)
	mux.HandleFunc("POST /api/generate", s.submit("generate"))
	mux.HandleFunc("POST /api/edit", s.submit("edit"))
	mux.HandleFunc("POST /api/uploads", s.upload)
	mux.HandleFunc("GET /api/jobs", s.listJobs)
	mux.HandleFunc("GET /api/jobs/{id}", s.getJob)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", s.cancelJob)
	mux.HandleFunc("GET /api/history", s.history)
	mux.HandleFunc("GET /api/history/{id}", s.historyItem)
	mux.HandleFunc("DELETE /api/history/{id}", s.deleteHistory)
	mux.HandleFunc("GET /api/files", s.file)
	mux.HandleFunc("GET /api/thumb", s.thumb)
	return s.wrap(mux)
}

func (s *Server) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("token")
		}
		if s.Token == "" || subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) != 1 {
			writeErr(w, http.StatusUnauthorized, "未授权：token 无效")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 256<<20))
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("请求体不是合法 JSON：%v", err)
	}
	return nil
}

// Publish 广播事件。
func (s *Server) Publish(typ string, data any) {
	ev := Event{Type: typ, Data: data, Time: time.Now().UnixMilli()}
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- ev:
		default: // 订阅者过慢则丢弃
		}
	}
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "不支持流式响应")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch := make(chan Event, 64)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()
	send := func(ev Event) {
		raw, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", raw)
		fl.Flush()
	}
	send(Event{Type: "hello", Data: map[string]string{"version": Version}, Time: time.Now().UnixMilli()})
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev := <-ch:
			send(ev)
		case <-tick.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	def, groups, err := s.Engine.Groups.Views()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	_, total := s.Engine.Store.List(store.Query{})
	s.mu.Lock()
	active := 0
	for _, j := range s.jobs {
		if j.Status == "running" {
			active++
		}
	}
	s.mu.Unlock()
	st := s.Engine.Store.Settings()
	writeJSON(w, 200, map[string]any{
		"version": Version, "pid": os.Getpid(), "uptime": int64(time.Since(s.start).Seconds()),
		"home": s.Engine.Home, "configPath": s.Engine.Groups.Path(), "outputDir": st.OutputDir,
		"groups": len(groups), "defaultGroup": def, "activeJobs": active, "historyCount": total,
		"codexConfigPath": config.CodexConfigPath(), "platform": runtime.GOOS, "core": "go",
	})
}

func (s *Server) listGroups(w http.ResponseWriter, r *http.Request) {
	def, groups, err := s.Engine.Groups.Views()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"defaultGroup": def, "groups": groups, "configPath": s.Engine.Groups.Path()})
}

func (s *Server) groupsChanged() {
	def, groups, _ := s.Engine.Groups.Views()
	s.Publish("groups", map[string]any{"defaultGroup": def, "groups": groups})
}

func (s *Server) createGroup(w http.ResponseWriter, r *http.Request) {
	var in config.Input
	if err := decode(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if err := s.Engine.Groups.Create(in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.Log.Printf("创建接口分组 %s", in.Name)
	s.groupsChanged()
	s.listGroups(w, r)
}

func (s *Server) updateGroup(w http.ResponseWriter, r *http.Request) {
	var in config.Input
	if err := decode(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	name := r.PathValue("name")
	if err := s.Engine.Groups.Modify(name, in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.Log.Printf("更新接口分组 %s", name)
	s.groupsChanged()
	s.listGroups(w, r)
}

func (s *Server) deleteGroup(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if err := s.Engine.Groups.Delete(name); err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	s.Log.Printf("删除接口分组 %s", name)
	s.groupsChanged()
	s.listGroups(w, r)
}

func (s *Server) defaultGroup(w http.ResponseWriter, r *http.Request) {
	if err := s.Engine.Groups.SetDefault(r.PathValue("name")); err != nil {
		writeErr(w, 404, err.Error())
		return
	}
	s.groupsChanged()
	s.listGroups(w, r)
}

func (s *Server) previewGroup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		BaseURL  string `json:"baseUrl"`
		AppendV1 bool   `json:"appendV1"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	eff := config.EffectiveBaseURL(in.BaseURL, in.AppendV1)
	res := map[string]any{"effectiveBaseUrl": eff, "generationsUrl": eff + "/images/generations", "editsUrl": eff + "/images/edits", "modelsUrl": eff + "/models"}
	if err := config.ValidateBaseURL(in.BaseURL); err != nil {
		res["error"] = err.Error()
	}
	writeJSON(w, 200, res)
}

func (s *Server) testGroup(w http.ResponseWriter, r *http.Request) {
	ep, err := s.Engine.Groups.Resolve(r.PathValue("name"))
	if err != nil {
		writeJSON(w, 200, imageapi.ProbeResult{Message: err.Error()})
		return
	}
	if r.ContentLength > 0 {
		var in struct {
			Model string `json:"model"`
		}
		if decode(r, &in) == nil && in.Model != "" {
			ep.Model = in.Model
		}
	}
	res := imageapi.New(20*time.Second).Probe(r.Context(), ep)
	s.Log.Printf("测试分组 %s：HTTP %d %dms", ep.Group, res.Status, res.LatencyMs)
	writeJSON(w, 200, res)
}

func (s *Server) importGroups(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path    string `json:"path"`
		JSON    string `json:"json"`
		Replace bool   `json:"replace"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	var src *config.File
	var err error
	if strings.TrimSpace(in.JSON) != "" {
		src = &config.File{}
		if err = json.Unmarshal([]byte(in.JSON), src); err != nil {
			writeErr(w, 400, "配置内容不是合法 JSON："+err.Error())
			return
		}
	} else {
		p := in.Path
		if p == "" {
			p = config.CodexConfigPath()
		}
		if src, err = config.ReadFile(p); err != nil {
			writeErr(w, 400, "读取配置失败："+err.Error())
			return
		}
	}
	if len(src.Groups) == 0 {
		writeErr(w, 400, "配置中没有任何分组（groups 为空）")
		return
	}
	n, err := s.Engine.Groups.Import(src, in.Replace)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.Log.Printf("导入 %d 个接口分组", n)
	s.groupsChanged()
	writeJSON(w, 200, map[string]any{"imported": n})
}

func (s *Server) exportGroups(w http.ResponseWriter, r *http.Request) {
	f, err := s.Engine.Groups.Export(r.URL.Query().Get("includeKeys") == "1")
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, f)
}

func (s *Server) exportGroupsToFile(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path        string `json:"path"`
		IncludeKeys bool   `json:"includeKeys"`
	}
	if err := decode(r, &in); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if in.Path == "" {
		in.Path = config.CodexConfigPath()
	}
	f, err := s.Engine.Groups.Export(in.IncludeKeys)
	if err == nil {
		err = config.WriteFile(in.Path, f)
	}
	if err != nil {
		writeErr(w, 500, "导出失败："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"path": in.Path, "groups": len(f.Groups)})
}

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.Engine.Store.Settings())
}

func (s *Server) putSettings(w http.ResponseWriter, r *http.Request) {
	var p store.SettingsPatch
	if err := decode(r, &p); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	st, err := s.Engine.Store.UpdateSettings(p)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.Publish("settings", st)
	writeJSON(w, 200, st)
}

func (s *Server) submit(mode string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req engine.Request
		if err := decode(r, &req); err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		req.Mode = mode
		p, err := s.Engine.Prepare(req)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
		job := s.StartJob(p)
		writeJSON(w, 202, job)
	}
}

// upload 直接接收图片文件流（请求体即原始字节，?name= 为原文件名），保存为临时附件并返回本地路径。
// 浏览器 / Android WebView / iOS WKWebView 的 <input type="file"> 拿不到系统绝对路径，可先上传再以 {"path": ...} 引用。
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<20))
	if err != nil {
		writeErr(w, 400, "读取上传内容失败："+err.Error())
		return
	}
	if len(data) == 0 {
		writeErr(w, 400, "上传内容为空")
		return
	}
	name, path, err := s.Engine.SaveUpload(r.URL.Query().Get("name"), data)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"path": path, "name": name, "size": len(data)})
}

func (s *Server) snapshot(j *Job) Job {
	cp := *j
	cp.cancel = nil
	if cp.Status == "running" {
		cp.ElapsedMs = time.Now().UnixMilli() - cp.CreatedAt
	}
	cp.Items = append([]store.Item{}, j.Items...)
	return cp
}

// StartJob 异步执行已校验的请求。
func (s *Server) StartJob(p *engine.Prepared) Job {
	ctx, cancel := context.WithCancel(context.Background())
	j := &Job{ID: engine.NewID(), Mode: p.Req.Mode, Status: "running", Group: p.Req.Group, Model: p.Req.Model,
		Prompt: p.Req.Prompt, Size: p.Req.Size, N: p.Req.N, InputCount: len(p.Images), CreatedAt: time.Now().UnixMilli(), Items: []store.Item{}, cancel: cancel}
	s.mu.Lock()
	s.jobs[j.ID] = j
	s.pruneLocked()
	snap := s.snapshot(j)
	s.mu.Unlock()
	s.Log.Printf("任务 %s 开始：%s 分组=%s 模型=%s n=%d", j.ID, j.Mode, j.Group, j.Model, j.N)
	s.Publish("job", snap)
	go func() {
		s.sem <- struct{}{}
		defer func() { <-s.sem }()
		items, err := s.Engine.Run(ctx, j.ID, p)
		s.mu.Lock()
		j.FinishedAt = time.Now().UnixMilli()
		j.ElapsedMs = j.FinishedAt - j.CreatedAt
		j.Items = items
		switch {
		case errors.Is(ctx.Err(), context.Canceled):
			j.Status, j.Error = "canceled", "已取消"
		case err != nil:
			j.Status, j.Error = "failed", err.Error()
		default:
			j.Status = "succeeded"
		}
		snap := s.snapshot(j)
		s.mu.Unlock()
		cancel()
		if err != nil {
			s.Log.Printf("任务 %s 失败（%dms）：%s", j.ID, j.ElapsedMs, j.Error)
		} else {
			s.Log.Printf("任务 %s 完成（%dms），保存 %d 张", j.ID, j.ElapsedMs, len(items))
		}
		s.Publish("job", snap)
		if len(items) > 0 {
			s.Publish("history", map[string]any{"added": len(items)})
		}
	}()
	return snap
}

func (s *Server) pruneLocked() {
	if len(s.jobs) <= 100 {
		return
	}
	list := make([]*Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		if j.Status != "running" {
			list = append(list, j)
		}
	}
	sort.Slice(list, func(a, b int) bool { return list[a].CreatedAt < list[b].CreatedAt })
	for i := 0; i < len(list) && len(s.jobs) > 100; i++ {
		delete(s.jobs, list[i].ID)
	}
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	out := make([]Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		out = append(out, s.snapshot(j))
	}
	s.mu.Unlock()
	sort.Slice(out, func(a, b int) bool { return out[a].CreatedAt > out[b].CreatedAt })
	writeJSON(w, 200, map[string]any{"jobs": out})
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j, ok := s.jobs[r.PathValue("id")]
	var snap Job
	if ok {
		snap = s.snapshot(j)
	}
	s.mu.Unlock()
	if !ok {
		writeErr(w, 404, "任务不存在")
		return
	}
	writeJSON(w, 200, snap)
}

func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	j, ok := s.jobs[r.PathValue("id")]
	if ok && j.cancel != nil && j.Status == "running" {
		j.cancel()
	}
	s.mu.Unlock()
	if !ok {
		writeErr(w, 404, "任务不存在")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) history(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	items, total := s.Engine.Store.List(store.Query{Q: q.Get("q"), Mode: q.Get("mode"), Group: q.Get("group"), Limit: limit})
	for i := range items {
		if _, err := os.Stat(items[i].Path); err != nil {
			items[i].FileSize = -1 // 文件已被移走或删除
		}
	}
	writeJSON(w, 200, map[string]any{"items": items, "total": total, "groups": s.Engine.Store.Groups()})
}

func (s *Server) historyItem(w http.ResponseWriter, r *http.Request) {
	it, ok := s.Engine.Store.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "记录不存在")
		return
	}
	writeJSON(w, 200, it)
}

func (s *Server) deleteHistory(w http.ResponseWriter, r *http.Request) {
	it, err := s.Engine.Store.Delete(r.PathValue("id"), r.URL.Query().Get("deleteFile") == "1")
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.Log.Printf("删除记录 %s（删除文件=%v）", it.ID, r.URL.Query().Get("deleteFile") == "1")
	s.Publish("history", map[string]any{"deleted": it.ID})
	writeJSON(w, 200, map[string]bool{"ok": true})
}

var imageExt = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

// allowedFile 只允许读取图片扩展名的常规文件（请求本身已经过 token 鉴权）。
func (s *Server) allowedFile(p string) (string, bool) {
	if p == "" || !filepath.IsAbs(p) {
		return "", false
	}
	p = filepath.Clean(p)
	if _, ok := imageExt[strings.ToLower(filepath.Ext(p))]; !ok {
		return "", false
	}
	fi, err := os.Stat(p)
	if err != nil || !fi.Mode().IsRegular() {
		return "", false
	}
	return p, true
}

func (s *Server) file(w http.ResponseWriter, r *http.Request) {
	p, ok := s.allowedFile(r.URL.Query().Get("path"))
	if !ok {
		writeErr(w, 404, "文件不存在或不是图片")
		return
	}
	w.Header().Set("Content-Type", imageExt[strings.ToLower(filepath.Ext(p))])
	w.Header().Set("Cache-Control", "private, max-age=60")
	if r.URL.Query().Get("download") == "1" {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(p)))
	}
	http.ServeFile(w, r, p)
}

func (s *Server) thumb(w http.ResponseWriter, r *http.Request) {
	p, ok := s.allowedFile(r.URL.Query().Get("path"))
	if !ok {
		writeErr(w, 404, "文件不存在或不是图片")
		return
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("w"))
	if size == 0 {
		size = 384
	}
	out, err := thumb.Get(filepath.Join(s.Engine.Home, "thumbs"), p, size)
	if err != nil {
		s.file(w, r) // 无法解码（如 WebP）时回退原图
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, out)
}

// Listen 仅监听 127.0.0.1。
func Listen(port int) (net.Listener, error) {
	return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
}
