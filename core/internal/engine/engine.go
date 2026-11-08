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

// Outcome 一次任务的实际结果（期望 / 接口返回 / 已保存 / 失败 张数与请求次数）。
type Outcome struct {
	Requested int `json:"requested"` // 期望张数（请求的 n）
	Received  int `json:"received"`  // 接口实际返回的图片条目数（含无法使用的）
	Saved     int `json:"saved"`     // 已保存到本地并写入历史的张数
	Failed    int `json:"failed"`    // 接口返回了但无法解码 / 下载 / 保存的张数
	Requests  int `json:"requests"`  // 实际发出的生图请求次数（含补图请求）
	// Notes 给用户看的说明（例如接口只返回了部分张数、已补请求几次）
	Notes    []string     `json:"notes,omitempty"`
	Items    []store.Item `json:"-"`
	Err      error        `json:"-"`
	Canceled bool         `json:"-"`
}

// Status 根据结果给出任务状态：succeeded（张数齐全）/ partial（只得到部分）/ failed / canceled。
func (o *Outcome) Status() string {
	switch {
	case o.Canceled:
		return "canceled"
	case o.Saved >= o.Requested && o.Err == nil:
		return "succeeded"
	case o.Saved > 0:
		return "partial"
	default:
		return "failed"
	}
}

// Summary 结果说明（失败原因 + 说明），用于任务的 error / 日志。
func (o *Outcome) Summary() string {
	var parts []string
	if o.Err != nil {
		parts = append(parts, o.Err.Error())
	}
	parts = append(parts, o.Notes...)
	return strings.Join(parts, "；")
}

// Run 执行请求并返回已保存的记录（CLI 用）：张数不足、部分失败或取消都返回错误，但已保存的记录照常返回。
func (e *Engine) Run(ctx context.Context, jobID string, p *Prepared) ([]store.Item, error) {
	o := e.Execute(ctx, jobID, p, nil)
	switch o.Status() {
	case "succeeded":
		return o.Items, nil
	case "canceled":
		return o.Items, errors.New("已取消")
	default:
		return o.Items, fmt.Errorf("期望 %d 张，实际保存 %d 张：%s", o.Requested, o.Saved, o.Summary())
	}
}

// Execute 执行请求：调用接口 → 防覆盖落盘 → 逐张写入历史。
// 接口返回张数少于 n 时（不少中转站忽略 n 只返回 1 张），按设置 missingPolicy=fill 逐张补请求（每次 n=1），
// 总请求次数不超过 n、累计张数够了即停止；任一请求出错、返回 0 张、有图片无法使用或被取消时立即停止，不会无限重试。
// 已保存的图片始终保留。progress 在每次保存后回调（可为 nil）。
func (e *Engine) Execute(ctx context.Context, jobID string, p *Prepared, progress func(*Outcome)) *Outcome {
	st := e.Store.Settings()
	client := e.NewClient(time.Duration(st.RequestTimeoutSec) * time.Second)
	o := &Outcome{Requested: p.Req.N}
	start := time.Now()
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
	maxRequests := 1
	if st.MissingPolicy == store.MissingFill {
		maxRequests = p.Req.N
	}
	for o.Received < o.Requested && o.Requests < maxRequests {
		n := o.Requested - o.Received
		if o.Requests > 0 {
			n = 1 // 补图请求每次只要 1 张：接口忽略 n 时不会按大 n 重复计费
		}
		params := imageapi.Params{
			Model: p.Req.Model, Prompt: p.Req.Prompt, Size: p.Req.Size, Quality: p.Req.Quality,
			Background: p.Req.Background, OutputFormat: p.Req.OutputFormat, N: n,
		}
		o.Requests++
		var imgs []imageapi.Image
		var err error
		if p.Req.Mode == "edit" {
			imgs, err = client.Edit(ctx, p.Endpoint, params, p.Images, p.Mask)
		} else {
			imgs, err = client.Generate(ctx, p.Endpoint, params)
		}
		if ctx.Err() != nil {
			o.Canceled = true
		}
		var pe *imageapi.PartialError
		partial := errors.As(err, &pe)
		if err != nil && !partial {
			if !o.Canceled {
				msg := config.Redact(err.Error(), p.Endpoint.Key)
				if o.Requests > 1 {
					msg = fmt.Sprintf("第 %d 次请求（补图）失败：%s", o.Requests, msg)
				}
				o.Err = errors.New(msg)
			}
			break
		}
		o.Received += len(imgs)
		if partial {
			o.Received += len(pe.Failures)
			o.Failed += len(pe.Failures)
			o.Err = errors.New(config.Redact(pe.Error(), p.Endpoint.Key))
		}
		for k, im := range imgs {
			// 接口多返回的图片也保存（已生成，可能已计费）
			it, err := e.saveOne(st, base, start, jobID, p, o.Saved, im)
			if err != nil {
				o.Failed += len(imgs) - k // 本张及本批之后未保存的
				o.Err = err
				break
			}
			o.Items = append(o.Items, it)
			o.Saved++
			if progress != nil {
				progress(o)
			}
		}
		if o.Err != nil || o.Canceled {
			break // 有图片无法使用 / 保存失败：这些图片接口已生成（可能已计费），不自动补，如实报告
		}
		if o.Requests == 1 && o.Received < o.Requested {
			o.Notes = append(o.Notes, fmt.Sprintf("接口只返回了 %d/%d 张（该接口可能不支持一次生成多张）", o.Received, o.Requested))
		}
	}
	if o.Requests > 1 {
		o.Notes = append(o.Notes, fmt.Sprintf("已逐张补请求 %d 次", o.Requests-1))
	}
	if !o.Canceled && o.Err == nil && o.Saved < o.Requested && st.MissingPolicy == store.MissingReport {
		o.Notes = append(o.Notes, "未自动补图（默认只报告，可在设置中开启“张数不足时逐张补图”）")
	}
	if o.Canceled {
		o.Notes = append(o.Notes, fmt.Sprintf("已取消，保留已生成的 %d 张", o.Saved))
	}
	if progress != nil {
		progress(o)
	}
	return o
}

func (e *Engine) saveOne(st store.Settings, base string, start time.Time, jobID string, p *Prepared, index int, im imageapi.Image) (store.Item, error) {
	b := base
	if p.Req.N > 1 {
		b = fmt.Sprintf("%s-%d", base, index+1)
	}
	path, err := imageapi.SaveNoOverwrite(st.OutputDir, b, imageapi.ExtFor(im.Data, p.Req.OutputFormat), im.Data)
	if err != nil {
		return store.Item{}, fmt.Errorf("保存第 %d 张图片失败：%v", index+1, err)
	}
	it := store.Item{
		ID: NewID(), JobID: jobID, CreatedAt: start.UnixMilli(), Mode: p.Req.Mode, Group: p.Req.Group,
		BaseURL: p.Endpoint.BaseURL, Model: p.Req.Model, Prompt: p.Req.Prompt, RevisedPrompt: im.RevisedPrompt,
		Size: p.Req.Size, Quality: p.Req.Quality, Background: p.Req.Background, OutputFormat: p.Req.OutputFormat,
		N: p.Req.N, Index: index, Path: path, FileSize: int64(len(im.Data)), ElapsedMs: time.Since(start).Milliseconds(),
		SourceURL: im.SourceURL, InputImages: p.Paths, Mask: p.MaskPath,
	}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(im.Data)); err == nil {
		it.Width, it.Height = cfg.Width, cfg.Height
	} else if w, h, ok := webpSize(im.Data); ok {
		it.Width, it.Height = w, h
	}
	if err := e.Store.AddItems(it); err != nil {
		return it, fmt.Errorf("写入历史失败：%v", err)
	}
	return it, nil
}
