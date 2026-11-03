#!/usr/bin/env python3
"""固定版の公式 Noto フォントから、4 スートだけの WOFF2 と OFL を再生成する。"""

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
DESTINATION = Path(__file__).resolve().parent.parent / "src" / "fonts"


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
    # OFL は UTF-8 であることを検証し、改行・著作権文を含む元のバイト列を保存する。
    license_text.decode("utf-8")
    with TemporaryDirectory(prefix="freecell-font-") as temporary:
        source = Path(temporary) / "source.ttf"
        target = Path(temporary) / "noto-sans-symbols-2-suits.woff2"
        source.write_bytes(original)
        options = subset.Options()
        options.flavor = "woff2"
        options.hinting = False
        options.recalc_timestamp = False
        # 著作権・ファミリー名・版・ライセンス URL もフォント内へ保持する。
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
        font = subset.load_font(source, options)
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=SUITS)
        subsetter.subset(font)
        subset.save_font(font, target, options)
        with TTFont(target) as result:
            if set(result.getBestCmap()) != SUITS:
                raise ValueError("出力された文字一覧が 4 スートと一致しません。")
        content = target.read_bytes()
    DESTINATION.mkdir(parents=True, exist_ok=True)
    (DESTINATION / target.name).write_bytes(content)
    (DESTINATION / "OFL.txt").write_bytes(license_text)
    print(f"{target.name}: {len(content)} bytes, SHA-256 {sha256(content).hexdigest()}")


if __name__ == "__main__":
    main()
