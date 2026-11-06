#!/usr/bin/env python3
"""发布前安装包结构校验（仅用标准库，Linux / macOS / Windows 均可运行）。

用法：python3 scripts/verify-release.py <目录> [--version 0.1.0]

校验内容（任何一项失败即退出码 1）：
- Windows：*-setup.exe 为 PE 可执行文件且是 NSIS 安装程序；*.msi 为 OLE 复合文档
- macOS：*_aarch64.dmg / *_x64.dmg 为 UDIF 镜像，解压后含对应架构（arm64 / x86_64）的 Mach-O 可执行文件
  （主程序 + imagegend 内核共 ≥ 2 个）与 Bundle ID
- Android：APK / AAB 为完整 ZIP，含清单、dex 与 arm64-v8a / armeabi-v7a / x86_64 三种原生库
- iOS：IPA 含 Payload/GPTImageStudio.app/{Info.plist, 可执行文件}，可执行文件为 arm64 Mach-O，
  Info.plist 的 Bundle ID / 版本 / NSAllowsLocalNetworking 正确
- 文件名中的版本号与 --version 一致；任何文件不得小于 1 MB；目录中不得出现私钥 / 密钥库 / 本地配置
"""
import argparse, glob, os, plistlib, re, struct, sys, zipfile, zlib

ap = argparse.ArgumentParser()
ap.add_argument("dir")
ap.add_argument("--version")
a = ap.parse_args()
os.chdir(a.dir)
errors = []

def fail(msg):
    errors.append(msg)
    print("  ✗", msg)

def ok(msg):
    print("  ✓", msg)

def need(pattern, label):
    files = sorted(glob.glob(pattern))
    if not files:
        fail(f"缺少 {label}（{pattern}）")
    for f in files:
        size = os.path.getsize(f)
        if size < 1024 * 1024:
            fail(f"{f} 体积异常：{size} 字节")
        if a.version and f"_{a.version}_" not in f:
            fail(f"{f} 文件名版本号与 {a.version} 不一致")
    return files

for f in os.listdir("."):
    if re.search(r"\.(key|jks|keystore|p12|pem|mobileprovision|properties|env)$", f, re.I):
        fail(f"发现疑似机密文件 {f}，禁止发布")

MACHO_CPU = {0x0100000C: "arm64", 0x01000007: "x86_64"}

def macho_exec(data):
    found = {}
    for m in re.finditer(rb"\xcf\xfa\xed\xfe", data):
        cpu, = struct.unpack("<I", data[m.start() + 4:m.start() + 8])
        ftype, = struct.unpack("<I", data[m.start() + 12:m.start() + 16])
        if cpu in MACHO_CPU and ftype == 2:  # MH_EXECUTE
            found[MACHO_CPU[cpu]] = found.get(MACHO_CPU[cpu], 0) + 1
    return found

print("Windows")
for f in need("*-setup.exe", "Windows NSIS 安装程序"):
    d = open(f, "rb").read()
    pe, = struct.unpack("<I", d[0x3C:0x40])
    if d[:2] == b"MZ" and d[pe:pe + 4] == b"PE\0\0" and b"Nullsoft" in d:
        ok(f"{f} PE / NSIS 安装程序")
    else:
        fail(f"{f} 不是 NSIS PE 安装程序")
for f in need("*.msi", "Windows MSI"):
    if open(f, "rb").read(8) == bytes.fromhex("d0cf11e0a1b11ae1"):
        ok(f"{f} MSI（OLE 复合文档）")
    else:
        fail(f"{f} 不是 MSI")

print("macOS")
for arch, pat in (("arm64", "*_aarch64.dmg"), ("x86_64", "*_x64.dmg")):
    for f in need(pat, f"macOS {arch} DMG"):
        d = open(f, "rb").read()
        k = d[-512:]
        if k[:4] != b"koly":
            fail(f"{f} 缺少 UDIF koly 尾部"); continue
        xo, xl = struct.unpack(">QQ", k[0xD8:0xE8])
        img = bytearray()
        try:
            for b in plistlib.loads(d[xo:xo + xl])["resource-fork"]["blkx"]:
                m = b["Data"]
                n, = struct.unpack(">I", m[200:204])
                for i in range(n):
                    t, _, _, sc, co, cl = struct.unpack(">IIQQQQ", m[204 + i * 40:244 + i * 40])
                    if t == 0x80000005:
                        img += zlib.decompress(d[co:co + cl])
                    elif t == 1:
                        img += d[co:co + cl]
                    elif t in (0, 2):
                        img += b"\0" * (sc * 512)
        except Exception as e:  # 非 zlib 压缩（UDBZ / ULFO 等）时给出明确提示
            fail(f"{f} 镜像解析失败：{e}"); continue
        found = macho_exec(img)
        if found.get(arch, 0) >= 2 and b"com.gptimagestudio.desktop" in img:
            ok(f"{f} UDIF，含 {found[arch]} 个 {arch} Mach-O 可执行文件（主程序 + imagegend），Bundle ID 正确")
        else:
            fail(f"{f} 镜像内容异常：Mach-O={found}")

print("Android")
ABIS = ("arm64-v8a", "armeabi-v7a", "x86_64")
for f in need("*.apk", "Android APK"):
    z = zipfile.ZipFile(f); n = set(z.namelist())
    libs = [x for x in ABIS if f"lib/{x}/libgpt_image_studio_lib.so" in n]
    if z.testzip() is None and {"AndroidManifest.xml", "classes.dex"} <= n and len(libs) == 3:
        ok(f"{f} ZIP 完整，含清单、dex 与 {', '.join(libs)} 原生库（v2/v3 签名请用 apksigner verify 复核）")
    else:
        fail(f"{f} APK 结构异常：libs={libs}")
for f in need("*.aab", "Android AAB"):
    z = zipfile.ZipFile(f); n = set(z.namelist())
    libs = [x for x in ABIS if f"base/lib/{x}/libgpt_image_studio_lib.so" in n]
    if z.testzip() is None and "base/manifest/AndroidManifest.xml" in n and len(libs) == 3:
        ok(f"{f} ZIP 完整，含 base 模块清单与三种原生库")
    else:
        fail(f"{f} AAB 结构异常：libs={libs}")

print("iOS")
for f in need("*_ios.ipa", "iOS IPA"):
    z = zipfile.ZipFile(f); n = set(z.namelist())
    app = "Payload/GPTImageStudio.app/"
    if z.testzip() is not None or app + "Info.plist" not in n:
        fail(f"{f} IPA 结构异常"); continue
    info = plistlib.loads(z.read(app + "Info.plist"))
    exe = app + info.get("CFBundleExecutable", "")
    found = macho_exec(z.read(exe)[:64]) if exe in n else {}
    checks = {
        "可执行文件为 arm64 Mach-O": found.get("arm64") == 1,
        "Bundle ID com.gptimagestudio.mobile": info.get("CFBundleIdentifier") == "com.gptimagestudio.mobile",
        "NSAllowsLocalNetworking": info.get("NSAppTransportSecurity", {}).get("NSAllowsLocalNetworking") is True,
        "版本号": not a.version or info.get("CFBundleShortVersionString") == a.version,
    }
    signed = app + "_CodeSignature/CodeResources" in n and "embedded.mobileprovision" in "".join(n)
    bad = [k for k, v in checks.items() if not v]
    if bad:
        fail(f"{f} 校验失败：{bad}")
    else:
        ok(f"{f} Payload 结构正确，arm64，iOS ≥ {info.get('MinimumOSVersion')}，{'已签名' if signed else '未签名（需自行重签后安装）'}")

if errors:
    print(f"\n校验失败 {len(errors)} 项")
    sys.exit(1)
print("\n全部安装包结构校验通过")
