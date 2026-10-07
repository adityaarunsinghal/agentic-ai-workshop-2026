# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Create and verify a fresh source ZIP from an explicit inclusion inventory."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import stat
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
EXPANDED_LIMIT = 128 * 1024 * 1024
COMPRESSED_LIMIT = 20 * 1024 * 1024
ENTRY_LIMIT = 5000
PRIVATE_NAMES = {
    ".git",
    ".local",
    ".venv",
    ".ruff_cache",
    "__pycache__",
    "node_modules",
    "tmp",
    ".DS_Store",
    "log.md",
}
KEY_NAMES = {"id_rsa", "id_ed25519", "credentials.json", "service-account.json"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def excluded(path: Path) -> bool:
    return (
        path.name in PRIVATE_NAMES
        or (path.name.startswith(".env") and path.name != ".env.example")
        or path.suffix in {".zip", ".log", ".pyc"}
    )


def inventory() -> tuple[list[Path], list[str]]:
    spec = json.loads((ROOT / "package-files.json").read_text())
    roots, directories = spec["rootFiles"], spec["directories"]
    declared = roots + directories
    if (
        len(set(declared)) != len(declared)
        or any(
            not isinstance(name, str) or Path(name).name != name for name in declared
        )
        or any(name in {".", ".."} for name in declared)
        or any(excluded(Path(name)) for name in declared)
    ):
        raise ValueError("Package entries must be distinct, public source names")
    paths: list[Path] = []
    omitted: list[str] = []

    def include(path: Path) -> None:
        relative = path.relative_to(ROOT).as_posix()
        if excluded(path):
            omitted.append(relative)
            return
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):
            raise ValueError(f"Linked or escaping package source: {relative}")
        if path.name in KEY_NAMES or path.suffix.lower() in {
            ".pem",
            ".key",
            ".p12",
            ".pfx",
        }:
            raise ValueError(
                f"Keep credential files outside package source: {relative}"
            )
        if path.is_dir():
            for child in sorted(path.iterdir()):
                include(child)
        elif path.is_file():
            paths.append(path)
        else:
            raise ValueError(f"Missing or unsupported package source: {relative}")

    for path in ROOT.iterdir():
        if excluded(path):
            omitted.append(path.name)
        elif path.name not in declared:
            raise ValueError(
                f"Undeclared root source: {path.name}. Add public source to "
                "package-files.json; keep private or generated work in .local/."
            )
    for name in roots:
        path = ROOT / name
        if not path.is_file():
            raise ValueError(f"Required root file is missing: {name}")
        include(path)
    for name in directories:
        path = ROOT / name
        if not path.is_dir():
            raise ValueError(f"Required source directory is missing: {name}")
        include(path)
    if len(paths) > ENTRY_LIMIT:
        raise ValueError("Package source exceeds the entry limit")
    return sorted(paths, key=lambda p: p.relative_to(ROOT).as_posix()), sorted(omitted)


def build(output: Path) -> dict:
    files, omitted = inventory()
    payload = {path.relative_to(ROOT).as_posix(): path.read_bytes() for path in files}
    # Example configuration has names and guidance, never filled credentials.
    for name, data in payload.items():
        if Path(name).name != ".env.example":
            continue
        for line in data.decode("utf-8").splitlines():
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                continue
            variable, value = line.split("=", 1)
            if (
                any(
                    term in variable.upper()
                    for term in ("KEY", "TOKEN", "SECRET", "PASSWORD")
                )
                and value.strip()
            ):
                raise ValueError("Leave credential values empty in .env.example")
    if sum(map(len, payload.values())) > EXPANDED_LIMIT:
        raise ValueError("Package source exceeds the expanded-size limit")
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.is_symlink():
        raise ValueError("The archive destination must not be a symbolic link")
    staging = output.with_suffix(".building.zip")
    if staging.is_symlink():
        raise ValueError("The staging destination must not be a symbolic link")
    with zipfile.ZipFile(
        staging, "w", zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        for name, data in payload.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data, compresslevel=9)
    if staging.stat().st_size > COMPRESSED_LIMIT:
        raise ValueError("Package source exceeds the compressed-size limit")
    with zipfile.ZipFile(staging) as archive:
        if archive.namelist() != list(payload):
            raise ValueError("ZIP inventory does not match source inventory")
        for name, data in payload.items():
            if archive.read(name) != data:
                raise ValueError(f"ZIP content differs: {name}")
            if (ROOT / name).read_bytes() != data:
                raise ValueError(f"Source changed during packaging: {name}")
    if output.exists() and digest(output.read_bytes()) != digest(staging.read_bytes()):
        old_hash = digest(output.read_bytes())
        trash = output.parent / f"trash-{datetime.now(timezone.utc):%Y-%m-%d}"
        trash.mkdir(exist_ok=True)
        previous = trash / f"{output.stem}-{old_hash[:12]}.zip"
        shutil.copy2(output, previous)
        if digest(previous.read_bytes()) != old_hash:
            raise ValueError("Previous archive backup failed verification")
    staging.replace(output)
    result = {
        "zip": str(output),
        "sha256": digest(output.read_bytes()),
        "bytes": output.stat().st_size,
        "entries": [
            {"path": name, "bytes": len(data), "sha256": digest(data)}
            for name, data in payload.items()
        ],
        "excluded": omitted,
    }
    output.with_suffix(".manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def extract(source: Path, destination: Path) -> dict:
    destination.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink() or any(destination.iterdir()):
        raise ValueError("Use a fresh empty verification directory")
    with zipfile.ZipFile(source) as archive:
        names: set[str] = set()
        total = 0
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            if (
                name.is_absolute()
                or any(part in {".", ".."} for part in name.parts)
                or "\\" in entry.filename
                or not name.parts
                or ":" in name.parts[0]
                or entry.filename in names
                or stat.S_ISLNK(entry.external_attr >> 16)
                or entry.is_dir()
                or any(excluded(Path(part)) for part in name.parts)
            ):
                raise ValueError("Unsafe or private archive entry")
            names.add(entry.filename)
            total += entry.file_size
            if total > EXPANDED_LIMIT or len(names) > ENTRY_LIMIT:
                raise ValueError("Archive exceeds source limits")
        for entry in archive.infolist():
            target = destination.joinpath(*PurePosixPath(entry.filename).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(entry))
    return {"extracted": len(names), "destination": str(destination)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    package = commands.add_parser("build")
    package.add_argument("--output", type=Path, required=True)
    unpack = commands.add_parser("extract")
    unpack.add_argument("--zip", type=Path, required=True)
    unpack.add_argument("--destination", type=Path, required=True)
    commands.add_parser("inventory")
    args = parser.parse_args()
    if args.command == "inventory":
        paths, omitted = inventory()
        result = {
            "files": [path.relative_to(ROOT).as_posix() for path in paths],
            "excluded": omitted,
        }
    elif args.command == "build":
        result = build(args.output.absolute())
        result["entries"] = len(result["entries"])
    else:
        result = extract(args.zip.absolute(), args.destination.absolute())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
