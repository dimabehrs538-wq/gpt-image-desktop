#!/usr/bin/env python3
"""用 tauri.conf.json 中的更新公钥校验 Tauri 更新签名（minisign 格式，仅需 cryptography 库）。

用法：
  python3 scripts/verify-updater-sig.py <文件> <文件.sig 或 base64 签名字符串> [--pubkey <base64 公钥>]
  python3 scripts/verify-updater-sig.py --latest-json latest.json --dir <安装包目录>   # 逐平台校验 latest.json

签名 / 公钥只做校验，不涉及任何私钥。
"""
import argparse, base64, hashlib, json, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def conf_pubkey():
    conf = json.load(open(os.path.join(ROOT, "app/src-tauri/tauri.conf.json"), encoding="utf-8"))
    return conf["plugins"]["updater"]["pubkey"]

def parse_pub(b64):
    lines = base64.b64decode(b64).decode().strip().splitlines()
    raw = base64.b64decode(lines[1])
    assert raw[:2] == b"Ed", "公钥算法不是 Ed25519"
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:42])

def verify(path, sig_b64, pub_b64):
    key_id, pk = parse_pub(pub_b64)
    lines = base64.b64decode(sig_b64).decode().strip().splitlines()
    raw = base64.b64decode(lines[1])
    alg, sig_key_id, sig = raw[:2], raw[2:10], raw[10:74]
    if sig_key_id != key_id:
        raise ValueError(f"签名密钥 ID {sig_key_id[::-1].hex().upper()} 与公钥 {key_id[::-1].hex().upper()} 不一致")
    data = open(path, "rb").read()
    msg = hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data
    pk.verify(sig, msg)  # 文件签名
    trusted = lines[2].split("trusted comment: ", 1)[1].encode()
    pk.verify(base64.b64decode(lines[3]), sig + trusted)  # 全局签名（含可信注释）
    return key_id[::-1].hex().upper(), trusted.decode()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?")
    ap.add_argument("sig", nargs="?")
    ap.add_argument("--pubkey")
    ap.add_argument("--latest-json")
    ap.add_argument("--dir", default=".")
    a = ap.parse_args()
    pub = a.pubkey or conf_pubkey()
    try:
        if a.latest_json:
            data = json.load(open(a.latest_json, encoding="utf-8"))
            print(f"latest.json 版本 {data['version']}，平台 {len(data['platforms'])} 个")
            for plat, ent in sorted(data["platforms"].items()):
                name = ent["url"].rsplit("/", 1)[1]
                kid, tc = verify(os.path.join(a.dir, name), ent["signature"], pub)
                print(f"  ✓ {plat:<22} {name}  密钥 {kid}  {tc}")
        else:
            sig = open(a.sig).read() if os.path.exists(a.sig) else a.sig
            kid, tc = verify(a.file, sig.strip(), pub)
            print(f"✓ 签名有效：密钥 {kid}；{tc}")
    except (InvalidSignature, ValueError, KeyError, FileNotFoundError) as e:
        print(f"✗ 签名校验失败：{type(e).__name__} {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
