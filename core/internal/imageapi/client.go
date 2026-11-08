// Package imageapi 调用 OpenAI 兼容的 /images/generations、/images/edits 与 /models 接口。
package imageapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
)

// Params 生图公共参数；空字符串表示不发送该字段（由服务端使用默认值）。
type Params struct {
	Model        string `json:"model"`
	Prompt       string `json:"prompt"`
	Size         string `json:"size,omitempty"`
	Quality      string `json:"quality,omitempty"`
	Background   string `json:"background,omitempty"`
	OutputFormat string `json:"outputFormat,omitempty"`
	N            int    `json:"n,omitempty"`
}

// InputImage 编辑接口的输入图片。
type InputImage struct {
	Name string
	Data []byte
}

// Image 单张结果（b64 已解码或 url 已下载）。
type Image struct {
	Data          []byte
	SourceURL     string
	RevisedPrompt string
	MIME          string
}

// APIError 接口返回的错误（已脱敏）。
type APIError struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
	Type    string `json:"type,omitempty"`
	Code    string `json:"code,omitempty"`
}

func (e *APIError) Error() string {
	s := fmt.Sprintf("HTTP %d", e.Status)
	if e.Status == 0 {
		s = "网络错误"
	}
	if e.Code != "" {
		s += " [" + e.Code + "]"
	}
	return s + "：" + e.Message
}

// PartialError 接口返回的图片中有部分无法解码 / 下载：与已成功的图片一起返回，调用方据此保留可用的结果。
type PartialError struct {
	Failures []string
}

func (e *PartialError) Error() string {
	return fmt.Sprintf("%d 张图片无法使用：%s", len(e.Failures), strings.Join(e.Failures, "；"))
}

// Client 简单 HTTP 客户端。
type Client struct {
	HTTP *http.Client
	UA   string
}

// New 创建客户端，timeout 为单次请求超时。
func New(timeout time.Duration) *Client {
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	return &Client{HTTP: &http.Client{Timeout: timeout}, UA: "GPTImageStudio/1.0"}
}

func validate(p *Params) error {
	if strings.TrimSpace(p.Prompt) == "" {
		return errors.New("提示词不能为空")
	}
	if p.Model == "" {
		return errors.New("模型不能为空")
	}
	if p.N < 0 || p.N > 10 {
		return errors.New("生成张数需在 1–10 之间")
	}
	if p.Size != "" && p.Size != "auto" {
		w, h, ok := strings.Cut(p.Size, "x")
		if _, e1 := strconv.Atoi(w); !ok || e1 != nil {
			return fmt.Errorf("尺寸格式不正确：%s（应为 宽x高，例如 1024x1024）", p.Size)
		}
		if _, e2 := strconv.Atoi(h); e2 != nil {
			return fmt.Errorf("尺寸格式不正确：%s（应为 宽x高，例如 1024x1024）", p.Size)
		}
	}
	return nil
}

// Generate 文生图。
func (c *Client) Generate(ctx context.Context, ep *config.Endpoint, p Params) ([]Image, error) {
	if err := validate(&p); err != nil {
		return nil, err
	}
	body := map[string]any{"model": p.Model, "prompt": p.Prompt}
	if p.N > 0 {
		body["n"] = p.N
	}
	for k, v := range map[string]string{"size": p.Size, "quality": p.Quality, "background": p.Background, "output_format": p.OutputFormat} {
		if v != "" {
			body[k] = v
		}
	}
	raw, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.BaseURL+"/images/generations", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(ctx, ep, req)
}

// Edit 图生图 / 图像编辑：单图用 image 字段，多图按顺序用 image[] 字段。
func (c *Client) Edit(ctx context.Context, ep *config.Endpoint, p Params, images []InputImage, mask *InputImage) ([]Image, error) {
	if err := validate(&p); err != nil {
		return nil, err
	}
	if len(images) == 0 {
		return nil, errors.New("请至少提供一张参考图")
	}
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("model", p.Model)
	_ = mw.WriteField("prompt", p.Prompt)
	if p.N > 0 {
		_ = mw.WriteField("n", strconv.Itoa(p.N))
	}
	for _, kv := range [][2]string{{"size", p.Size}, {"quality", p.Quality}, {"background", p.Background}, {"output_format", p.OutputFormat}} {
		if kv[1] != "" {
			_ = mw.WriteField(kv[0], kv[1])
		}
	}
	field := "image"
	if len(images) > 1 {
		field = "image[]"
	}
	for _, im := range images {
		if err := writeFile(mw, field, im); err != nil {
			return nil, err
		}
	}
	if mask != nil && len(mask.Data) > 0 {
		if err := writeFile(mw, "mask", *mask); err != nil {
			return nil, err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.BaseURL+"/images/edits", &buf)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return c.do(ctx, ep, req)
}

func writeFile(mw *multipart.Writer, field string, im InputImage) error {
	name := filepath.Base(im.Name)
	if name == "" || name == "." {
		name = "image.png"
	}
	mime := http.DetectContentType(im.Data)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, field, strings.ReplaceAll(name, `"`, "")))
	h.Set("Content-Type", mime)
	w, err := mw.CreatePart(h)
	if err != nil {
		return err
	}
	_, err = w.Write(im.Data)
	return err
}

type imagesResponse struct {
	Data []struct {
		B64JSON       string `json:"b64_json"`
		URL           string `json:"url"`
		RevisedPrompt string `json:"revised_prompt"`
	} `json:"data"`
}

func (c *Client) do(ctx context.Context, ep *config.Endpoint, req *http.Request) ([]Image, error) {
	req.Header.Set("Authorization", "Bearer "+ep.Key)
	req.Header.Set("User-Agent", c.UA)
	req.Header.Set("Accept", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, &APIError{Message: config.Redact(err.Error(), ep.Key)}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 512<<20))
	if err != nil {
		return nil, &APIError{Status: resp.StatusCode, Message: "读取响应失败：" + config.Redact(err.Error(), ep.Key)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, ParseError(resp.StatusCode, raw, ep.Key)
	}
	var ir imagesResponse
	if err := json.Unmarshal(raw, &ir); err != nil {
		return nil, &APIError{Status: resp.StatusCode, Message: "响应不是合法 JSON：" + snippet(config.Redact(string(raw), ep.Key))}
	}
	if len(ir.Data) == 0 {
		return nil, &APIError{Status: resp.StatusCode, Message: "接口未返回任何图片（data 为空）"}
	}
	out := make([]Image, 0, len(ir.Data))
	var failures []string
	for i, d := range ir.Data {
		var im Image
		im.RevisedPrompt = d.RevisedPrompt
		switch {
		case d.B64JSON != "":
			b64 := d.B64JSON
			if j := strings.Index(b64, ","); strings.HasPrefix(b64, "data:") && j > 0 {
				b64 = b64[j+1:]
			}
			data, err := base64.StdEncoding.DecodeString(b64)
			if err != nil {
				failures = append(failures, fmt.Sprintf("第 %d 张图片 b64_json 解码失败：%v", i+1, err))
				continue
			}
			im.Data = data
		case d.URL != "":
			data, err := c.download(ctx, d.URL)
			if err != nil {
				if ctx.Err() != nil {
					return out, ctx.Err()
				}
				failures = append(failures, fmt.Sprintf("第 %d 张图片下载失败：%s", i+1, config.Redact(err.Error(), ep.Key)))
				continue
			}
			im.Data, im.SourceURL = data, d.URL
		default:
			failures = append(failures, fmt.Sprintf("第 %d 张图片既没有 b64_json 也没有 url", i+1))
			continue
		}
		im.MIME = http.DetectContentType(im.Data)
		out = append(out, im)
	}
	if len(failures) > 0 {
		// 部分（或全部）条目不可用：可用的图片照常返回，调用方保存并如实统计失败张数
		return out, &PartialError{Failures: failures}
	}
	return out, nil
}

func (c *Client) download(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", c.UA)
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 256<<20))
}

// ParseError 解析 OpenAI 风格错误体并脱敏。
func ParseError(status int, raw []byte, key string) *APIError {
	e := &APIError{Status: status}
	var body struct {
		Error json.RawMessage `json:"error"`
		Msg   string          `json:"message"`
	}
	if json.Unmarshal(raw, &body) == nil {
		var obj struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    any    `json:"code"`
		}
		var str string
		if len(body.Error) > 0 && json.Unmarshal(body.Error, &obj) == nil && obj.Message != "" {
			e.Message, e.Type = obj.Message, obj.Type
			if obj.Code != nil {
				e.Code = fmt.Sprint(obj.Code)
			}
		} else if len(body.Error) > 0 && json.Unmarshal(body.Error, &str) == nil && str != "" {
			e.Message = str
		} else if body.Msg != "" {
			e.Message = body.Msg
		}
	}
	if e.Message == "" {
		e.Message = snippet(strings.TrimSpace(string(raw)))
		if e.Message == "" {
			e.Message = http.StatusText(status)
		}
	}
	e.Message = config.Redact(e.Message, key)
	return e
}

func snippet(s string) string {
	r := []rune(s)
	if len(r) > 300 {
		return string(r[:300]) + "…"
	}
	return s
}

// ProbeResult 测试连接结果。
type ProbeResult struct {
	OK             bool   `json:"ok"`
	Status         int    `json:"status"`
	LatencyMs      int64  `json:"latencyMs"`
	Message        string `json:"message"`
	URL            string `json:"url"`
	ModelCount     int    `json:"modelCount"`
	ModelListed    bool   `json:"modelListed"`
	ModelsReturned bool   `json:"modelsReturned"`
}

// Probe 向 {base}/models 发起鉴权探测。
func (c *Client) Probe(ctx context.Context, ep *config.Endpoint) ProbeResult {
	r := ProbeResult{URL: ep.BaseURL + "/models"}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		r.Message = err.Error()
		return r
	}
	req.Header.Set("Authorization", "Bearer "+ep.Key)
	req.Header.Set("User-Agent", c.UA)
	start := time.Now()
	resp, err := c.HTTP.Do(req)
	r.LatencyMs = time.Since(start).Milliseconds()
	if err != nil {
		r.Message = "无法连接：" + config.Redact(err.Error(), ep.Key)
		return r
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	r.Status = resp.StatusCode
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		r.Message = ParseError(resp.StatusCode, raw, ep.Key).Error()
		return r
	}
	r.OK = true
	var ml struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &ml) == nil && ml.Data != nil {
		r.ModelsReturned = true
		// 与模型列表缓存的 total 语义一致：统计不同的非空模型 ID（重复 ID 只计一次）
		seen := map[string]bool{}
		for _, m := range ml.Data {
			if m.ID != "" && !seen[m.ID] {
				seen[m.ID] = true
			}
			if m.ID == ep.Model {
				r.ModelListed = true
			}
		}
		r.ModelCount = len(seen)
	}
	switch {
	case !r.ModelsReturned:
		r.Message = "连接成功（接口未返回模型列表）"
	case r.ModelListed:
		r.Message = fmt.Sprintf("连接成功，模型 %s 可用（共 %d 个不同模型）", ep.Model, r.ModelCount)
	default:
		r.Message = fmt.Sprintf("连接成功，共 %d 个不同模型，但列表中未找到 %s（部分中转站不列出生图模型，可直接尝试）", r.ModelCount, ep.Model)
	}
	return r
}
