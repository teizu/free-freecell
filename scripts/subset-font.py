#!/usr/bin/env python3
"""固定版の公式 Noto フォントから、52 枚・4 スート・行メトリクス用の空白を生成する。"""

from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen

from fontTools import subset
from fontTools.ttLib import TTFont


COMMIT = "8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5"
BASE_URL = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl/notosanssymbols2"
SOURCES = {
    "NotoSansSymbols2-Regular.ttf": "7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21",
    "OFL.txt": "b118dd41337806a5d4797052c77caf3bd096aed783e5eb21b4d11154351e1ac0",
}
SUITS = {0x2660, 0x2663, 0x2665, 0x2666}
# 各スートの 0xC は Knight。通常の 52 枚には含めず、Q=0xD・K=0xE を使う。
CARDS = {
    base + rank
    for base in (0x1F0A0, 0x1F0B0, 0x1F0C0, 0x1F0D0)
    for rank in range(1, 15)
    if rank != 12
}
# 空白も含め、CSS の基本行メトリクスが別フォントへフォールバックしないようにする。
CHARACTERS = SUITS | CARDS | {0x20}
ROOT = Path(__file__).resolve().parent.parent
DESTINATION = ROOT / "src" / "fonts"
LICENSE_DESTINATION = ROOT / "docs" / "licenses"


def download(name: str) -> bytes:
    """公式の固定 URL を取得し、元ファイルの SHA-256 が一致する場合だけ採用する。"""
    request = Request(f"{BASE_URL}/{name}", headers={"User-Agent": "free-freecell-font-subset"})
    with urlopen(request, timeout=30) as response:
        content = response.read()
    if sha256(content).hexdigest() != SOURCES[name]:
        raise ValueError(f"公式ファイルのハッシュが一致しません: {name}")
    return content


def main() -> None:
    """図形と縦メトリクスを保ち、不要な文字とヒンティングだけを取り除く。"""
    original = download("NotoSansSymbols2-Regular.ttf")
    license_text = download("OFL.txt")
    # OFL 原本は開発資料へ保存し、配布フォント内には著作権・宣言・公式 URL を保つ。
    copyright_notice = license_text.decode("utf-8").splitlines()[0]
    with TemporaryDirectory(prefix="freecell-font-") as temporary:
        source = Path(temporary) / "source.ttf"
        target = Path(temporary) / "noto-sans-symbols-2-cards.woff2"
        source.write_bytes(original)
        options = subset.Options()
        options.flavor = "woff2"
        options.hinting = False
        options.recalc_timestamp = False
        # 著作権・ファミリー名・版・ライセンス URL もフォント内へ保持する。
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
        font = subset.load_font(source, options)
        license_fields = {name_id: font["name"].getDebugName(name_id) for name_id in (0, 13, 14)}
        if (license_fields[0] != copyright_notice
                or "SIL Open Font License, Version 1.1" not in (license_fields[13] or "")
                or license_fields[14] != "https://scripts.sil.org/OFL"):
            raise ValueError("元フォントの著作権・OFL 宣言・公式 URL を確認できません。")
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=CHARACTERS)
        subsetter.subset(font)
        subset.save_font(font, target, options)
        with TTFont(target) as result:
            if set(result.getBestCmap()) != CHARACTERS:
                raise ValueError("出力された文字一覧が 52 枚・4 スート・空白の 57 文字に一致しません。")
            if any(result["name"].getDebugName(name_id) != value for name_id, value in license_fields.items()):
                raise ValueError("出力フォントの著作権・OFL 宣言・公式 URL が変更または欠落しています。")
        content = target.read_bytes()
    DESTINATION.mkdir(parents=True, exist_ok=True)
    LICENSE_DESTINATION.mkdir(parents=True, exist_ok=True)
    (DESTINATION / target.name).write_bytes(content)
    (LICENSE_DESTINATION / "OFL.txt").write_bytes(license_text)
    print(f"{target.name}: {len(content)} bytes, SHA-256 {sha256(content).hexdigest()}")


if __name__ == "__main__":
    main()
