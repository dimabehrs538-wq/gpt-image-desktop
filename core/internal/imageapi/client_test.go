package imageapi

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gpt-image-desktop/core/internal/config"
)

const testKey = "sk-test-SECRET-1234567890"

func pngBytes(t *testing.T, c color.Color) []byte {
	img := image.NewRGBA(image.Rect(0, 0, 8, 6))
	for y := 0; y < 6; y++ {
		for x := 0; x < 8; x++ {
			img.Set(x, y, c)
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func ep(url string) *config.Endpoint {
	return &config.Endpoint{Group: "g", BaseURL: url + "/v1", Key: testKey, Model: "gpt-image-2"}
}

func TestGenerateB64AndURL(t *testing.T) {
	img := pngBytes(t, color.RGBA{255, 0, 0, 255})
	var got map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/images/generations", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testKey {
			w.WriteHeader(401)
			return
		}
		got = nil
		json.NewDecoder(r.Body).Decode(&got)
		host := "http://" + r.Host
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{
			{"b64_json": base64.StdEncoding.EncodeToString(img), "revised_prompt": "a red square"},
			{"url": host + "/files/x.png"},
		}})
	})
	mux.HandleFunc("/files/x.png", func(w http.ResponseWriter, r *http.Request) { w.Write(img) })
	srv := httptest.NewServer(mux)
	defer srv.Close()

	res, err := New(0).Generate(context.Background(), ep(srv.URL), Params{Model: "gpt-image-2", Prompt: "red", Size: "1536x1024", Quality: "high", Background: "transparent", OutputFormat: "png", N: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 2 || !bytes.Equal(res[0].Data, img) || !bytes.Equal(res[1].Data, img) || res[0].RevisedPrompt != "a red square" || res[1].SourceURL == "" {
		t.Fatalf("bad result %+v", res)
	}
	want := map[string]any{"model": "gpt-image-2", "prompt": "red", "size": "1536x1024", "quality": "high", "background": "transparent", "output_format": "png", "n": float64(2)}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("field %s=%v want %v", k, got[k], v)
		}
	}
	// 空字段不发送
	_, _ = New(0).Generate(context.Background(), ep(srv.URL), Params{Model: "dall-e-3", Prompt: "x"})
	if _, ok := got["background"]; ok {
		t.Error("empty background should be omitted")
	}
	if _, err := New(0).Generate(context.Background(), ep(srv.URL), Params{Model: "m", Prompt: "x", Size: "huge"}); err == nil {
		t.Error("expected size validation error")
	}
}

func TestEditMultipart(t *testing.T) {
	a, b, m := pngBytes(t, color.White), pngBytes(t, color.Black), pngBytes(t, color.Transparent)
	var fields map[string][]string
	var files map[string][][]byte
	var names []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/edits" || r.Header.Get("Authorization") != "Bearer "+testKey {
			w.WriteHeader(404)
			return
		}
		if err := r.ParseMultipartForm(32 << 20); err != nil {
			w.WriteHeader(400)
			return
		}
		fields = r.MultipartForm.Value
		files = map[string][][]byte{}
		names = nil
		for k, fhs := range r.MultipartForm.File {
			for _, fh := range fhs {
				f, _ := fh.Open()
				d, _ := io.ReadAll(f)
				files[k] = append(files[k], d)
				names = append(names, k+":"+fh.Filename)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]string{{"b64_json": base64.StdEncoding.EncodeToString(a)}}})
	}))
	defer srv.Close()

	c := New(0)
	_, err := c.Edit(context.Background(), ep(srv.URL), Params{Model: "gpt-image-2", Prompt: "merge", Quality: "low", N: 1},
		[]InputImage{{Name: "first.png", Data: a}, {Name: "second.png", Data: b}}, &InputImage{Name: "mask.png", Data: m})
	if err != nil {
		t.Fatal(err)
	}
	if len(files["image[]"]) != 2 || !bytes.Equal(files["image[]"][0], a) || !bytes.Equal(files["image[]"][1], b) {
		t.Fatalf("image[] order wrong: %v", names)
	}
	if len(files["mask"]) != 1 || fields["prompt"][0] != "merge" || fields["model"][0] != "gpt-image-2" || fields["quality"][0] != "low" {
		t.Fatalf("fields=%v names=%v", fields, names)
	}
	// 单图使用 image 字段
	if _, err := c.Edit(context.Background(), ep(srv.URL), Params{Model: "gpt-image-2", Prompt: "one"}, []InputImage{{Name: "a.png", Data: a}}, nil); err != nil {
		t.Fatal(err)
	}
	if len(files["image"]) != 1 || len(files["image[]"]) != 0 || len(files["mask"]) != 0 {
		t.Fatalf("single image field wrong: %v", names)
	}
	if _, err := c.Edit(context.Background(), ep(srv.URL), Params{Model: "m", Prompt: "x"}, nil, nil); err == nil {
		t.Fatal("expected no-image error")
	}
}

func TestErrorsRedacted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			w.WriteHeader(401)
			w.Write([]byte(`{"error":{"message":"Incorrect API key provided: ` + testKey + `","type":"invalid_request_error","code":"invalid_api_key"}}`))
		case "/v1/models":
			w.Write([]byte(`{"data":[{"id":"gpt-image-2"},{"id":"gpt-4o"}]}`))
		default:
			w.WriteHeader(502)
			w.Write([]byte("bad gateway " + testKey))
		}
	}))
	defer srv.Close()
	_, err := New(0).Generate(context.Background(), ep(srv.URL), Params{Model: "gpt-image-2", Prompt: "x"})
	ae, ok := err.(*APIError)
	if !ok || ae.Status != 401 || ae.Code != "invalid_api_key" {
		t.Fatalf("err=%v", err)
	}
	if strings.Contains(err.Error(), testKey) || !strings.Contains(err.Error(), "sk-••••7890") {
		t.Fatalf("key leaked or not masked: %v", err)
	}
	_, err = New(0).Edit(context.Background(), ep(srv.URL), Params{Model: "gpt-image-2", Prompt: "x"}, []InputImage{{Name: "a.png", Data: pngBytes(t, color.White)}}, nil)
	if err == nil || strings.Contains(err.Error(), testKey) || !strings.Contains(err.Error(), "HTTP 502") {
		t.Fatalf("edit err=%v", err)
	}
	pr := New(0).Probe(context.Background(), ep(srv.URL))
	if !pr.OK || pr.ModelCount != 2 || !pr.ModelListed {
		t.Fatalf("probe=%+v", pr)
	}
	// 无法连接
	dead := ep("http://127.0.0.1:1")
	if pr := New(0).Probe(context.Background(), dead); pr.OK {
		t.Fatal("probe to dead host should fail")
	}
}

func TestSaveNoOverwrite(t *testing.T) {
	dir := t.TempDir()
	p1, err := SaveNoOverwrite(dir, "cat", ".png", []byte("1"))
	if err != nil {
		t.Fatal(err)
	}
	p2, _ := SaveNoOverwrite(dir, "cat", ".png", []byte("2"))
	p3, _ := SaveNoOverwrite(dir, "cat", ".png", []byte("3"))
	if filepath.Base(p1) != "cat.png" || filepath.Base(p2) != "cat-2.png" || filepath.Base(p3) != "cat-3.png" {
		t.Fatalf("%s %s %s", p1, p2, p3)
	}
	if d, _ := os.ReadFile(p1); string(d) != "1" {
		t.Fatal("original overwritten")
	}
	if SafeBase(" 我的 图片/../x ") != "x" || SafeBase("Hello World!") != "Hello-World" {
		t.Fatalf("safebase %q %q", SafeBase(" 我的 图片/../x "), SafeBase("Hello World!"))
	}
	if ExtFor(pngBytes(t, color.White), "jpeg") != ".png" || ExtFor([]byte("??"), "webp") != ".webp" {
		t.Fatal("ext detection")
	}
}
