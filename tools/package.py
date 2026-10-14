"""Create a source archive from an explicit public-file allowlist, never session files."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
files = [root / name for name in (
    "README.md", "package.json", "package-lock.json", ".gitignore", ".gitattributes", ".env.example",
    "session.example.json", "research/REPORT.md", "START-BOT.cmd", "start.sh", "install-ubuntu.sh",
)]
for directory, patterns in {
    "src": ("*.js",), "test": ("*.test.js", "*.sh"),
    "tools": ("*.js", "*.py", "*.ps1"),
    "deploy": ("*.sh", "*.service"), "profiles": ("industrial-1.7.10.json",),
}.items():
    for pattern in patterns:
        files.extend((root / directory).glob(pattern))
destination = root / "dist" / "mcskill-afk.zip"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for path in sorted(set(files)):
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise SystemExit("Refusing external/symlink source")
        relative = path.relative_to(root).as_posix()
        info = ZipInfo("mcskill-afk/" + relative)
        info.compress_type = ZIP_DEFLATED
        info.external_attr = (0o100755 if path.suffix == ".sh" else 0o100644) << 16
        archive.writestr(info, path.read_bytes())
print(f"Created public source archive: {destination.name}; {len(files)} files")
