# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
import argparse
import hashlib
import io
import json
from datetime import UTC, datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--slug", required=True, help="Exact address claimed in My app.")
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
manifest_bytes = (root / "workshop-app.json").read_bytes()
manifest = json.loads(manifest_bytes)
# ZIP structure can be valid while its slug differs from the claimed address.
if manifest["slug"] != args.slug:
    parser.error(
        f'workshop-app.json uses "{manifest["slug"]}"; My app uses "{args.slug}". '
        f'Set the manifest slug to "{args.slug}", then package again.'
    )
names = (
    ".env.example",
    "app.py",
    "index.html",
    "chat.js",
    "montserrat.woff2",
    "OFL.txt",
    "pyproject.toml",
    "uv.lock",
    "workshop-app.json",
    "README.md",
    "package.py",
)
data = {
    name: manifest_bytes if name == "workshop-app.json" else (root / name).read_bytes()
    for name in names
}
buffer = io.BytesIO()
with ZipFile(buffer, "w") as archive:
    for name, contents in sorted(data.items()):
        entry = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
        # Read shared-font links, then write regular bytes into the portable ZIP.
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        entry.compress_type = ZIP_DEFLATED
        archive.writestr(entry, contents)
payload = buffer.getvalue()
output = args.output.expanduser().absolute()
if output.suffix != ".zip":
    parser.error("--output must name a .zip file.")
output.parent.mkdir(parents=True, exist_ok=True)
if output.is_symlink():
    parser.error("The ZIP destination must be a regular file.")
if output.exists() and output.read_bytes() != payload:
    trash = output.parent / ("trash-" + datetime.now(UTC).strftime("%Y-%m-%d-%H%M%S"))
    trash.mkdir()
    output.rename(trash / output.name)
output.write_bytes(payload)
with ZipFile(output) as archive:
    assert set(archive.namelist()) == set(names)
    for name, contents in data.items():
        assert archive.read(name) == contents
print(
    json.dumps(
        {
            "zip": str(output),
            "slug": args.slug,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }
    )
)
