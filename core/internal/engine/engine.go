// Package engine 把分组配置、接口客户端与本地存储组合成一次完整的生图流程。
package engine

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/imageapi"
	"github.com/gpt-image-desktop/core/internal/store"
)

// ImageInput 参考图 / 蒙版：path（本地文件）或 dataUrl（data:image/png;base64,...）二选一。
type ImageInput struct {
	Path    string `json:"path,omitempty"`
	DataURL string `json:"dataUrl,omitempty"`
	Name    string `json:"name,omitempty"`
}

// Request 一次生图请求。
type Request struct {
	Mode         string       `json:"mode"` // generate / edit
	Group        string       `json:"group"`
	Model        string       `json:"model"`
	Prompt       string       `json:"prompt"`
	Size         string       `json:"size"`
	Quality      string       `json:"quality"`
	Background   string       `json:"background"`
	OutputFormat string       `json:"outputFormat"`
	N            int          `json:"n"`
	Name         string       `json:"name"`
	Images       []ImageInput `json:"images,omitempty"`
	Mask         *ImageInput  `json:"mask,omitempty"`
}

// Engine 生图引擎。
type Engine struct {
	Groups *config.Store
	Store  *store.Store
	Home   string
	// NewClient 可在测试中替换
	NewClient func(timeout time.Duration) *imageapi.Client
}

// New 创建引擎。
func New(groups *config.Store, st *store.Store, home string) *Engine {
	return &Engine{Groups: groups, Store: st, Home: home, NewClient: imageapi.New}
}

// NewID 生成随机 ID。
func NewID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return time.Now().Format("20060102150405") + "-" + hex.EncodeToString(b)
}

// Prepared 校验通过、可以执行的请求。
type Prepared struct {
	Req      Request
	Endpoint *config.Endpoint
	Images   []imageapi.InputImage
	Paths    []string
	Mask     *imageapi.InputImage
	MaskPath string
}

// Prepare 校验请求并解析分组、读取输入图片（同步执行，便于立即返回参数错误）。
func (e *Engine) Prepare(req Request) (*Prepared, error) {
	if req.Mode == "" {
		req.Mode = "generate"
	}
	if req.Mode != "generate" && req.Mode != "edit" {
		return nil, fmt.Errorf("未知的模式：%s", req.Mode)
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, errors.New("提示词不能为空")
	}
	if req.N == 0 {
		req.N = 1
	}
	if req.N < 1 || req.N > 10 {
		return nil, errors.New("生成张数需在 1–10 之间")
	}
	ep, err := e.Groups.Resolve(req.Group)
	if err != nil {
		return nil, err
	}
	req.Group = ep.Group
	if strings.TrimSpace(req.Model) != "" {
		ep.Model = strings.TrimSpace(req.Model) // 严格使用用户指定的模型
	}
	req.Model = ep.Model
	p := &Prepared{Req: req, Endpoint: ep}
	if req.Mode == "edit" {
		if len(req.Images) == 0 {
			return nil, errors.New("图生图需要至少一张参考图")
		}
		if len(req.Images) > 16 {
			return nil, errors.New("参考图最多 16 张")
		}
		for i, in := range req.Images {
			im, path, err := e.loadInput(in)
			if err != nil {
				return nil, fmt.Errorf("参考图 %d：%v", i+1, err)
			}
			p.Images = append(p.Images, im)
			p.Paths = append(p.Paths, path)
		}
		if req.Mask != nil && (req.Mask.Path != "" || req.Mask.DataURL != "") {
			im, path, err := e.loadInput(*req.Mask)
			if err != nil {
				return nil, fmt.Errorf("蒙版：%v", err)
			}
			p.Mask, p.MaskPath = &im, path
		}
	}
	return p, nil
}

func (e *Engine) loadInput(in ImageInput) (imageapi.InputImage, string, error) {
	if in.Path != "" {
		data, err := os.ReadFile(in.Path)
		if err != nil {
			return imageapi.InputImage{}, "", fmt.Errorf("无法读取 %s：%v", in.Path, err)
		}
		if !strings.HasPrefix(http_detect(data), "image/") {
			return imageapi.InputImage{}, "", fmt.Errorf("%s 不是图片文件", filepath.Base(in.Path))
		}
		return imageapi.InputImage{Name: filepath.Base(in.Path), Data: data}, in.Path, nil
	}
	if in.DataURL == "" {
		return imageapi.InputImage{}, "", errors.New("缺少图片数据")
	}
	b64 := in.DataURL
	if i := strings.Index(b64, ","); strings.HasPrefix(b64, "data:") && i > 0 {
		b64 = b64[i+1:]
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return imageapi.InputImage{}, "", errors.New("图片数据解码失败")
	}
	name, path, err := e.SaveUpload(in.Name, data)
	if err != nil {
		return imageapi.InputImage{}, "", err
	}
	return imageapi.InputImage{Name: name, Data: data}, path, nil
}

// SaveUpload 校验并保存上传的参考图副本到 home/inputs/YYYY-MM（便于“复用参数”与历史追溯），返回 (文件名, 路径)。
func (e *Engine) SaveUpload(name string, data []byte) (string, string, error) {
	if !strings.HasPrefix(http_detect(data), "image/") {
		return "", "", errors.New("上传的文件不是图片")
	}
	if name == "" {
		name = "input" + imageapi.ExtFor(data, "")
	}
	ext := filepath.Ext(name)
	if ext == "" {
		ext = imageapi.ExtFor(data, "")
	}
	base := imageapi.SafeBase(strings.TrimSuffix(name, ext))
	if base == "" {
		base = "input"
	}
	dir := filepath.Join(e.Home, "inputs", time.Now().Format("2006-01"))
	path, err := imageapi.SaveNoOverwrite(dir, base, strings.ToLower(ext), data)
	if err != nil {
		return "", "", fmt.Errorf("保存参考图副本失败：%v", err)
	}
	return name, path, nil
}

// Run 执行请求：调用接口 → 防覆盖落盘 → 写入历史。
func (e *Engine) Run(ctx context.Context, jobID string, p *Prepared) ([]store.Item, error) {
	st := e.Store.Settings()
	client := e.NewClient(time.Duration(st.RequestTimeoutSec) * time.Second)
	params := imageapi.Params{
		Model: p.Req.Model, Prompt: p.Req.Prompt, Size: p.Req.Size, Quality: p.Req.Quality,
		Background: p.Req.Background, OutputFormat: p.Req.OutputFormat, N: p.Req.N,
	}
	start := time.Now()
	var imgs []imageapi.Image
	var err error
	if p.Req.Mode == "edit" {
		imgs, err = client.Edit(ctx, p.Endpoint, params, p.Images, p.Mask)
	} else {
		imgs, err = client.Generate(ctx, p.Endpoint, params)
	}
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		return nil, errors.New(config.Redact(err.Error(), p.Endpoint.Key))
	}
	base := imageapi.SafeBase(p.Req.Name)
	if base == "" {
		prefix := imageapi.SafeBase(st.FilenamePrefix)
		if prefix == "" {
			prefix = "imagegen"
		}
		if p.Req.Mode == "edit" {
			prefix += "-edit"
		}
		base = prefix + "-" + start.Format("20060102-150405")
	}
	items := make([]store.Item, 0, len(imgs))
	for i, im := range imgs {
		b := base
		if len(imgs) > 1 {
			b = fmt.Sprintf("%s-%d", base, i+1)
		}
		path, err := imageapi.SaveNoOverwrite(st.OutputDir, b, imageapi.ExtFor(im.Data, p.Req.OutputFormat), im.Data)
		if err != nil {
			return items, fmt.Errorf("保存图片失败：%v", err)
		}
		it := store.Item{
			ID: NewID(), JobID: jobID, CreatedAt: start.UnixMilli(), Mode: p.Req.Mode, Group: p.Req.Group,
			BaseURL: p.Endpoint.BaseURL, Model: p.Req.Model, Prompt: p.Req.Prompt, RevisedPrompt: im.RevisedPrompt,
			Size: p.Req.Size, Quality: p.Req.Quality, Background: p.Req.Background, OutputFormat: p.Req.OutputFormat,
			N: p.Req.N, Index: i, Path: path, FileSize: int64(len(im.Data)), ElapsedMs: elapsed,
			SourceURL: im.SourceURL, InputImages: p.Paths, Mask: p.MaskPath,
		}
		if cfg, _, err := image.DecodeConfig(bytes.NewReader(im.Data)); err == nil {
			it.Width, it.Height = cfg.Width, cfg.Height
		} else if w, h, ok := webpSize(im.Data); ok {
			it.Width, it.Height = w, h
		}
		items = append(items, it)
	}
	if err := e.Store.AddItems(items...); err != nil {
		return items, fmt.Errorf("写入历史失败：%v", err)
	}
	return items, nil
}
