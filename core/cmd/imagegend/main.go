// imagegend：GPT 生图桌面端的本地内核（Tauri sidecar），同时提供命令行调试子命令。
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gpt-image-desktop/core/internal/config"
	"github.com/gpt-image-desktop/core/internal/engine"
	"github.com/gpt-image-desktop/core/internal/rotlog"
	"github.com/gpt-image-desktop/core/internal/server"
	"github.com/gpt-image-desktop/core/internal/store"
)

const usage = `imagegend —— GPT 生图桌面端本地内核

用法:
  imagegend serve    [--home DIR] [--api-port N] [--token T] [--output-dir DIR] [--exit-on-stdin-close]
  imagegend status   [--home DIR]
  imagegend groups   [--home DIR] [list|add|update|rm|default|test|import|export] ...
  imagegend generate [--home DIR] --prompt P [--group G] [--model M] [--size S] [--quality Q]
                     [--background B] [--format png|jpeg|webp] [--n N] [--name NAME]
  imagegend edit     [--home DIR] --image A.png [--image B.png ...] [--mask M.png] --prompt P [同 generate 参数]
  imagegend history  [--home DIR] [--q KEYWORD] [--mode generate|edit] [--group G] [--limit N]
  imagegend history  rm ID [--delete-file]
  imagegend settings [--home DIR] [--output-dir DIR] [--timeout SEC] [--prefix NAME]
  imagegend version
`

func defaultHome() string {
	if h := os.Getenv("IMAGEGEN_HOME"); h != "" {
		return h
	}
	if d, err := os.UserConfigDir(); err == nil {
		return filepath.Join(d, "GPTImageDesktop")
	}
	h, _ := os.UserHomeDir()
	return filepath.Join(h, ".gpt-image-desktop")
}

func defaultOutput() string {
	h, _ := os.UserHomeDir()
	return filepath.Join(h, "GPTImageDesktop", "output", "imagegen")
}

type env struct {
	home   string
	groups *config.Store
	store  *store.Store
	engine *engine.Engine
}

func open(home string) *env {
	if err := os.MkdirAll(home, 0o700); err != nil {
		fatal("无法创建数据目录 %s：%v", home, err)
	}
	g := config.NewStore(filepath.Join(home, "groups.json"))
	st := store.New(home, defaultOutput())
	return &env{home: home, groups: g, store: st, engine: engine.New(g, st, home)}
}

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "错误："+f+"\n", a...)
	os.Exit(1)
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "serve":
		serve(args)
	case "status":
		status(args)
	case "groups":
		groups(args)
	case "generate", "edit":
		generate(cmd, args)
	case "history":
		history(args)
	case "settings":
		settings(args)
	case "version", "--version", "-v":
		fmt.Println("imagegend", server.Version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Print(usage)
		os.Exit(2)
	}
}

func randToken() string {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type daemonInfo struct {
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	Token     string `json:"token"`
	Home      string `json:"home"`
	OutputDir string `json:"outputDir"`
	Version   string `json:"version"`
	StartedAt string `json:"startedAt"`
}

func serve(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	home := fs.String("home", defaultHome(), "数据目录")
	port := fs.Int("api-port", 0, "本地 API 端口（0 = 随机）")
	token := fs.String("token", "", "Bearer Token（为空则随机生成）")
	outDir := fs.String("output-dir", "", "图片输出目录（写入设置）")
	exitOnStdin := fs.Bool("exit-on-stdin-close", false, "stdin 关闭时退出（作为 Tauri sidecar 运行）")
	_ = fs.Parse(args)

	e := open(*home)
	_ = os.MkdirAll(filepath.Join(e.home, "logs"), 0o700)
	var out io.Writer = os.Stderr
	if rl, err := rotlog.Open(filepath.Join(e.home, "logs", "imagegend.log"), 5<<20, 3); err == nil {
		out = io.MultiWriter(os.Stderr, rl)
		defer rl.Close()
	}
	lg := log.New(out, "", log.LstdFlags)

	if *outDir != "" {
		if _, err := e.store.UpdateSettings(store.SettingsPatch{OutputDir: outDir}); err != nil {
			fatal("%v", err)
		}
	}
	if *token == "" {
		*token = randToken()
	}
	ln, err := server.Listen(*port)
	if err != nil {
		fatal("监听端口失败：%v", err)
	}
	actual := ln.Addr().(interface{ String() string }).String()
	var realPort int
	fmt.Sscanf(actual[strings.LastIndex(actual, ":")+1:], "%d", &realPort)

	srv := server.New(*token, e.engine, lg)
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	info := daemonInfo{PID: os.Getpid(), Port: realPort, Token: *token, Home: e.home, OutputDir: e.store.Settings().OutputDir, Version: server.Version, StartedAt: time.Now().Format(time.RFC3339)}
	raw, _ := json.MarshalIndent(info, "", "  ")
	dj := filepath.Join(e.home, "daemon.json")
	if err := os.WriteFile(dj, raw, 0o600); err != nil {
		lg.Printf("写入 daemon.json 失败：%v", err)
	}
	_ = os.Chmod(dj, 0o600)
	lg.Printf("imagegend %s 已启动：http://127.0.0.1:%d 数据目录=%s 输出目录=%s", server.Version, realPort, e.home, info.OutputDir)

	stop := make(chan string, 2)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { s := <-sig; stop <- "收到信号 " + s.String() }()
	if *exitOnStdin {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop <- "stdin 已关闭" }()
	}
	go func() {
		if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			stop <- "服务异常：" + err.Error()
		}
	}()
	reason := <-stop
	lg.Printf("正在退出（%s）", reason)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = hs.Shutdown(ctx)
	_ = os.Remove(dj)
}

func homeFlag(fs *flag.FlagSet) *string { return fs.String("home", defaultHome(), "数据目录") }

func status(args []string) {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	home := homeFlag(fs)
	_ = fs.Parse(args)
	raw, err := os.ReadFile(filepath.Join(*home, "daemon.json"))
	if err != nil {
		fmt.Println("内核未运行（未找到 daemon.json）")
		os.Exit(1)
	}
	var d daemonInfo
	_ = json.Unmarshal(raw, &d)
	req, _ := http.NewRequest("GET", fmt.Sprintf("http://127.0.0.1:%d/api/status", d.Port), nil)
	req.Header.Set("Authorization", "Bearer "+d.Token)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		fmt.Printf("内核未响应（端口 %d）：%v\n", d.Port, err)
		os.Exit(1)
	}
	defer resp.Body.Close()
	var v any
	_ = json.NewDecoder(resp.Body).Decode(&v)
	printJSON(v)
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func groups(args []string) {
	sub := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("groups "+sub, flag.ExitOnError)
	home := homeFlag(fs)
	name := fs.String("name", "", "分组标识")
	base := fs.String("base-url", "", "baseUrl")
	appendV1 := fs.Bool("append-v1", false, "自动补 /v1")
	model := fs.String("model", "", "默认模型")
	key := fs.String("api-key", "", "API Key（明文，保存于 0600 配置文件）")
	keyEnv := fs.String("api-key-env", "", "保存 API Key 的环境变量名")
	path := fs.String("path", "", "导入 / 导出文件路径（默认 ~/.codex/image-api-groups.json）")
	replace := fs.Bool("replace", false, "导入时替换全部分组")
	includeKeys := fs.Bool("include-keys", false, "导出时包含明文 api_key")
	makeDefault := fs.Bool("default", false, "设为默认分组")
	_ = fs.Parse(args)
	if *name == "" && fs.NArg() > 0 {
		*name = fs.Arg(0)
	}
	e := open(*home)
	in := config.Input{Name: *name, BaseURL: *base, AppendV1: *appendV1, Model: *model, APIKey: *key, APIKeyEnv: *keyEnv, MakeDefault: *makeDefault}
	if *keyEnv != "" {
		in.KeySource = "env"
	}
	var err error
	switch sub {
	case "list":
	case "add":
		err = e.groups.Create(in)
	case "update":
		err = e.groups.Modify(*name, in)
	case "rm", "delete":
		err = e.groups.Delete(*name)
	case "default":
		err = e.groups.SetDefault(*name)
	case "test":
		ep, rerr := e.groups.Resolve(*name)
		if rerr != nil {
			fatal("%v", rerr)
		}
		printJSON(e.engine.NewClient(20*time.Second).Probe(context.Background(), ep))
		return
	case "import":
		p := *path
		if p == "" {
			p = config.CodexConfigPath()
		}
		src, rerr := config.ReadFile(p)
		if rerr != nil {
			fatal("%v", rerr)
		}
		n, ierr := e.groups.Import(src, *replace)
		if ierr != nil {
			fatal("%v", ierr)
		}
		fmt.Printf("已从 %s 导入 %d 个分组\n", p, n)
	case "export":
		f, xerr := e.groups.Export(*includeKeys)
		if xerr != nil {
			fatal("%v", xerr)
		}
		if *path == "" {
			printJSON(f)
			return
		}
		if werr := config.WriteFile(*path, f); werr != nil {
			fatal("%v", werr)
		}
		fmt.Printf("已导出 %d 个分组到 %s（权限 0600）\n", len(f.Groups), *path)
		return
	default:
		fatal("未知的 groups 子命令：%s", sub)
	}
	if err != nil {
		fatal("%v", err)
	}
	def, views, verr := e.groups.Views()
	if verr != nil {
		fatal("%v", verr)
	}
	printJSON(map[string]any{"defaultGroup": def, "groups": views})
}

func generate(mode string, args []string) {
	fs := flag.NewFlagSet(mode, flag.ExitOnError)
	home := homeFlag(fs)
	var images multi
	req := engine.Request{Mode: mode}
	fs.StringVar(&req.Prompt, "prompt", "", "提示词")
	fs.StringVar(&req.Group, "group", "", "接口分组（默认使用默认分组）")
	fs.StringVar(&req.Model, "model", "", "模型（默认使用分组模型）")
	fs.StringVar(&req.Size, "size", "", "尺寸，如 1024x1024")
	fs.StringVar(&req.Quality, "quality", "", "画质 auto/high/medium/low/hd/standard")
	fs.StringVar(&req.Background, "background", "", "背景 auto/transparent/opaque")
	fs.StringVar(&req.OutputFormat, "format", "", "输出格式 png/jpeg/webp")
	fs.IntVar(&req.N, "n", 1, "张数")
	fs.StringVar(&req.Name, "name", "", "文件名前缀")
	mask := fs.String("mask", "", "蒙版图片（仅 edit）")
	fs.Var(&images, "image", "参考图（可重复，按顺序上传）")
	_ = fs.Parse(args)
	for _, p := range images {
		abs, _ := filepath.Abs(p)
		req.Images = append(req.Images, engine.ImageInput{Path: abs})
	}
	if *mask != "" {
		abs, _ := filepath.Abs(*mask)
		req.Mask = &engine.ImageInput{Path: abs}
	}
	e := open(*home)
	p, err := e.engine.Prepare(req)
	if err != nil {
		fatal("%v", err)
	}
	fmt.Fprintf(os.Stderr, "正在请求 %s（分组 %s，模型 %s）…\n", p.Endpoint.BaseURL, p.Req.Group, p.Req.Model)
	items, err := e.engine.Run(context.Background(), engine.NewID(), p)
	if err != nil {
		fatal("%v", err)
	}
	printJSON(items)
}

func history(args []string) {
	if len(args) > 0 && args[0] == "rm" {
		fs := flag.NewFlagSet("history rm", flag.ExitOnError)
		home := homeFlag(fs)
		del := fs.Bool("delete-file", false, "同时删除图片文件")
		_ = fs.Parse(args[1:])
		if fs.NArg() == 0 {
			fatal("请指定记录 ID")
		}
		if _, err := open(*home).store.Delete(fs.Arg(0), *del); err != nil {
			fatal("%v", err)
		}
		fmt.Println("已删除")
		return
	}
	fs := flag.NewFlagSet("history", flag.ExitOnError)
	home := homeFlag(fs)
	q := store.Query{}
	fs.StringVar(&q.Q, "q", "", "关键词")
	fs.StringVar(&q.Mode, "mode", "", "generate / edit")
	fs.StringVar(&q.Group, "group", "", "分组")
	fs.IntVar(&q.Limit, "limit", 20, "最多条数")
	_ = fs.Parse(args)
	items, total := open(*home).store.List(q)
	printJSON(map[string]any{"total": total, "items": items})
}

func settings(args []string) {
	fs := flag.NewFlagSet("settings", flag.ExitOnError)
	home := homeFlag(fs)
	out := fs.String("output-dir", "", "输出目录")
	timeout := fs.Int("timeout", 0, "请求超时（秒）")
	prefix := fs.String("prefix", "\x00", "文件名前缀")
	_ = fs.Parse(args)
	e := open(*home)
	p := store.SettingsPatch{}
	if *out != "" {
		p.OutputDir = out
	}
	if *timeout != 0 {
		p.RequestTimeoutSec = timeout
	}
	if *prefix != "\x00" {
		p.FilenamePrefix = prefix
	}
	st, err := e.store.UpdateSettings(p)
	if err != nil {
		fatal("%v", err)
	}
	printJSON(st)
}
