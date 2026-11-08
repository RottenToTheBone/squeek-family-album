"""Make the Pages artifact. Keep all legacy raw URLs; pack new originals losslessly."""
import base64
import gzip
import hashlib
import json
import shutil
import sys
from pathlib import Path


STATIC = ("index.html", "app.css", "app.js", "chain.js", "lineage.js", "receipts.js", "share.js", "compare.js", "qr.js",
          "svg.js", "packed-art.js", "mark.svg", "cover.png", "social-cover.png",
          "data/archive.json", "data/current.json")


def package(source, target):
    if target.exists() or source.resolve() in target.resolve().parents:
        raise ValueError("Use a new output directory outside dist")
    target.mkdir(parents=True)
    historical = json.loads((source / "data/archive.json").read_bytes())["portraits"]
    if any(not k.isdecimal() or not 1 <= int(k) <= 9999 or str(int(k)) != k for k in historical):
        raise ValueError("Unexpected historical token ID")
    public = list(STATIC) + [f"art/{token}.svg" for token in historical]
    if (source / "data/site-revision.txt").is_file():
        public.append("data/site-revision.txt")
    for name in public:
        if (source / name).is_symlink():
            raise ValueError("Unexpected symlink in site")
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / name, dest)
    (target / "current-art").mkdir()
    records = json.loads((source / "data/current.json").read_bytes())["portraits"]
    groups = {}
    for token, record in records.items():
        if not token.isdecimal() or not 1 <= int(token) <= 9999 or str(int(token)) != token:
            raise ValueError("Unexpected token ID")
        src = source / "current-art" / (token + ".svg")
        if src.is_symlink():
            raise ValueError("Unexpected portrait symlink")
        if not record.get("pack"):
            shutil.copyfile(src, target / "current-art" / src.name)
            continue
        name = f"current-packs/{int(token) // 128}.json"
        if record["pack"] != name:
            raise ValueError("Unexpected portrait pack path")
        original = src.read_bytes()
        if hashlib.sha256(original).hexdigest() != record["sha256"]:
            raise ValueError(f"Original #{token} differs from its recorded digest")
        groups.setdefault(name, {})[token] = base64.b64encode(gzip.compress(original, compresslevel=6, mtime=0)).decode("ascii")
    for name, packed in groups.items():
        output = target / name
        output.parent.mkdir(exist_ok=True)
        payload = json.dumps(packed, separators=(",", ":")).encode("ascii")
        if len(payload) > 6_000_000:
            raise ValueError("Portrait pack exceeds the browser limit")
        output.write_bytes(payload)
        # Verify the actual serialized delivery bytes against each recorded original.
        for token, text in json.loads(output.read_bytes()).items():
            raw = gzip.decompress(base64.b64decode(text, validate=True))
            if hashlib.sha256(raw).hexdigest() != records[token]["sha256"]:
                raise ValueError("Pack round-trip failed for #" + token)
    print(f"Pages artifact: {len(records)} current originals, {sum(map(len, groups.values()))} in {len(groups)} packs")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: package_site.py NEW_OUTPUT_DIRECTORY")
    package(Path(__file__).resolve().parents[1] / "dist", Path(sys.argv[1]))
