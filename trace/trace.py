"""loopfinder trace hook for Python. Run as `python trace.py <script> [args...]` by `loopfinder build`.

The script really runs; this hook records what it reads, writes, fetches and spawns.
  - Writes are NOT performed: open/io.open/os.open for writing (pathlib goes through io.open),
    os rename/replace/remove/unlink/rmdir/truncate/link/chmod..., shutil rmtree/move/copy*,
    are recorded and dropped. SQLite databases are opened read-only.
  - Network (any socket connection) and subprocesses are blocked unless LOOPFINDER_ALLOW_NETWORK /
    LOOPFINDER_ALLOW_SUBPROCESS is set. When blocked, the call is recorded and then raises.
  - Not covered: C extensions that do their own I/O, and anything that bypasses these modules.
    This is a recorder, not a sandbox.

Who did it is the nearest frame in a file under LOOPFINDER_ROOT (not this hook, not site-packages).
The record is written to LOOPFINDER_OUT at the end (the only real write).
"""
import builtins
import io
import json
import os
import re
import runpy
import shutil
import socket
import sqlite3
import subprocess
import sys
import urllib.request

ROOT = os.path.abspath(os.environ.get("LOOPFINDER_ROOT") or os.getcwd()).replace("\\", "/").rstrip("/")
OUT = os.environ.get("LOOPFINDER_OUT")
ALLOW_NET = bool(os.environ.get("LOOPFINDER_ALLOW_NETWORK"))
ALLOW_EXEC = bool(os.environ.get("LOOPFINDER_ALLOW_SUBPROCESS"))
LEVEL = "#" * int(os.environ.get("LOOPFINDER_HEADING_LEVEL") or 2)
SELF = os.path.abspath(__file__).replace("\\", "/")
events = []
quiet = [0]  # while > 0 nothing is recorded (inner calls of something already recorded)

_open = builtins.open
_os_open = os.open
_listdir, _scandir, _walk = os.listdir, os.scandir, os.walk
_exists, _isfile, _isdir, _getmtime = os.path.exists, os.path.isfile, os.path.isdir, os.path.getmtime
_urlopen = urllib.request.urlopen
_connect = socket.socket.connect
_connect_ex = socket.socket.connect_ex
_popen_init = subprocess.Popen.__init__
_sqlite_connect = sqlite3.connect


def norm(p):
    return os.path.abspath(os.fspath(p)).replace("\\", "/")


def under_root(f):
    return f == ROOT or f.startswith(ROOT + "/")


def caller():
    f = sys._getframe(2)
    while f:
        name = f.f_code.co_filename
        if name.startswith("<"):  # <frozen os>, <string>...: made relative, they would land under the root
            f = f.f_back
            continue
        file = os.path.abspath(name).replace("\\", "/")
        if file != SELF and "/site-packages/" not in file and under_root(file):
            return file
        f = f.f_back
    return None


# The interpreter's own files (stdlib, site-packages, the zip of the stdlib) are what `import` looks at,
# not what the script reads. Recording them flooded every Python flow with dozens of nodes.
PY_HOMES = tuple(sorted({os.path.abspath(p).replace("\\", "/").rstrip("/") + "/" for p in (sys.prefix, sys.base_prefix, sys.exec_prefix)}))


def record(kind, target, **extra):
    if quiet[0]:
        return None
    if kind in ("read", "write") and isinstance(target, str) and (target + "/").startswith(PY_HOMES):
        return None
    by = caller()
    if not by:
        return None
    ev = {"by": by, "kind": kind, "target": target, **extra}
    events.append(ev)
    return ev


def is_path(p):
    return isinstance(p, (str, bytes, os.PathLike))


# ---- what a Markdown write would change, by heading (for section hubs) ----
def split_sections(text):
    text = text.replace("\r\n", "\n")
    out = {}
    body = text
    m = re.match(r"---\n.*?\n---", text, re.S)
    if m:
        out["frontmatter"] = m.group(0)
        body = text[m.end():]
    head = "(before the first heading)"
    pat = re.compile(r"^" + re.escape(LEVEL) + r" (.+?)\s*$")
    for line in body.split("\n"):
        h = pat.match(line)
        if h:
            head = h.group(1)
            out[head] = ""
            continue
        out[head] = out.get(head, "") + line + "\n"
    return out


class SectionBuffer(io.StringIO):
    """Stands in for a Markdown file opened for writing; on close, records which headings would change."""

    def __init__(self, path, append, event):
        super().__init__()
        self._path, self._append, self._event = path, append, event

    def close(self):
        if not self.closed and self._event is not None:
            try:
                with _open(self._path, encoding="utf-8") as f:
                    before = f.read()
            except OSError:
                before = ""
            after = before + self.getvalue() if self._append else self.getvalue()
            a, b = split_sections(before), split_sections(after)
            self._event["sections"] = [k for k in dict.fromkeys([*a, *b]) if a.get(k) != b.get(k)]
        super().close()


# ---- open ----
def traced_open(file, mode="r", *args, **kwargs):
    if isinstance(file, int):
        return _open(file, mode, *args, **kwargs)
    target = norm(file)
    if any(c in mode for c in "wax+"):
        ev = record("write", target)
        if target.endswith(".md") and "b" not in mode:
            return SectionBuffer(target, "a" in mode, ev)
        return io.BytesIO() if "b" in mode else io.StringIO()
    record("read", target)
    return _open(file, mode, *args, **kwargs)


WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def traced_os_open(path, flags, *args, **kwargs):
    if is_path(path) and flags & WRITE_FLAGS:
        record("write", norm(path))
        return _os_open(os.devnull, os.O_WRONLY)
    if is_path(path):
        record("read", norm(path))
    return _os_open(path, flags, *args, **kwargs)


# ---- reads ----
def look(fn, folder=False):
    def inner(p=".", *args, **kwargs):
        if is_path(p):
            record("read", norm(p) + ("/" if folder else ""))
        return fn(p, *args, **kwargs)
    return inner


# ---- writes: recorded, never performed ----
def dropped(target_index=0, silent=False, reads_first=False):
    def inner(*args, **kwargs):
        if reads_first and args and is_path(args[0]):
            record("read", norm(args[0]))
        if not silent and len(args) > target_index and is_path(args[target_index]):
            record("write", norm(args[target_index]))
        return None
    return inner


def traced_sqlite_connect(database, *args, **kwargs):
    if is_path(database) and str(database) != ":memory:":
        p = norm(database)
        record("read", p)
        if not _exists(p):
            return _sqlite_connect(":memory:")
        kwargs.pop("uri", None)
        return _sqlite_connect("file:" + p + "?mode=ro", *args, uri=True, **kwargs)
    return _sqlite_connect(database, *args, **kwargs)


# ---- network ----
class NetworkBlocked(ConnectionError):
    pass


def net_check(target):
    if not ALLOW_NET:
        raise NetworkBlocked("loopfinder: network is blocked (%s); rerun with --allow-network to let it through" % target)


def traced_urlopen(req, *args, **kwargs):
    url = req if isinstance(req, str) else req.full_url
    record("fetch", url)
    quiet[0] += 1  # the socket below would record the same request again
    try:
        net_check(url)
        return _urlopen(req, *args, **kwargs)
    finally:
        quiet[0] -= 1


def sock_target(address):
    if isinstance(address, tuple) and len(address) >= 2:
        return "tcp://%s:%s" % (address[0], address[1])
    return "unix:%s" % (address,)


def traced_connect(self, address):
    target = sock_target(address)
    record("fetch", target)
    net_check(target)
    return _connect(self, address)


def traced_connect_ex(self, address):
    target = sock_target(address)
    record("fetch", target)
    net_check(target)
    return _connect_ex(self, address)


# ---- subprocesses ----
class SubprocessBlocked(OSError):
    pass


def exec_target(cmd, cwd=None):
    argv = list(cmd) if isinstance(cmd, (list, tuple)) else str(cmd).split()
    argv = [str(a) for a in argv]
    # `git -C <repo> ...` reads that repository
    if argv and os.path.basename(argv[0]).startswith("git") and "-C" in argv:
        return "read", norm(argv[argv.index("-C") + 1])
    urls = [a for a in argv if a.startswith(("http://", "https://"))]
    if urls:
        return "fetch", urls[0]
    return "exec", os.path.basename(argv[0]) if argv else ""


def exec_check(cmd, cwd=None):
    kind, target = exec_target(cmd, cwd)
    record(kind, target)
    if not ALLOW_EXEC:
        raise SubprocessBlocked("loopfinder: subprocesses are blocked (%s); rerun with --allow-subprocess to let them run" % target)


def traced_popen_init(self, args, *rest, **kwargs):
    exec_check(args, kwargs.get("cwd"))
    quiet[0] += 1
    try:
        return _popen_init(self, args, *rest, **kwargs)
    finally:
        quiet[0] -= 1


def blocked_shell(name, fn):
    def inner(cmd, *args, **kwargs):
        exec_check(cmd)
        return fn(cmd, *args, **kwargs)
    return inner


def install():
    builtins.open = traced_open
    io.open = traced_open
    os.open = traced_os_open
    os.listdir, os.scandir = look(_listdir, True), look(_scandir, True)
    os.walk = look(_walk, True)
    os.path.exists, os.path.isfile, os.path.isdir = look(_exists), look(_isfile), look(_isdir)
    os.path.getmtime = look(_getmtime)
    for name in ("remove", "unlink", "rmdir", "removedirs", "truncate", "chmod", "chown", "utime", "lchown"):
        if hasattr(os, name):
            setattr(os, name, dropped(0))
    for name in ("rename", "replace", "symlink", "link"):
        setattr(os, name, dropped(1))
    os.makedirs = dropped(silent=True)
    os.mkdir = dropped(silent=True)
    shutil.rmtree = dropped(0)
    shutil.move = dropped(1, reads_first=True)
    for name in ("copy", "copy2", "copyfile", "copytree", "copymode", "copystat"):
        setattr(shutil, name, dropped(1, reads_first=True))
    sqlite3.connect = traced_sqlite_connect
    urllib.request.urlopen = traced_urlopen
    socket.socket.connect = traced_connect
    socket.socket.connect_ex = traced_connect_ex
    subprocess.Popen.__init__ = traced_popen_init
    os.system = blocked_shell("system", os.system)
    os.popen = blocked_shell("popen", os.popen)
    # shutil.which probes every PATH entry; that is not the script reading those folders
    _which = shutil.which

    def which(*a, **k):
        quiet[0] += 1
        try:
            return _which(*a, **k)
        finally:
            quiet[0] -= 1
    shutil.which = which


def main():
    script = os.path.abspath(sys.argv[1])
    sys.argv = [script] + sys.argv[2:]
    sys.path.insert(0, os.path.dirname(script))
    install()
    code = 0
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else 0
    except BaseException as e:  # the record so far is still worth keeping
        sys.stderr.write("loopfinder: the script raised %s: %s\n" % (type(e).__name__, e))
        code = 1
    finally:
        builtins.open = _open
        io.open = _open
        if OUT:
            with _open(OUT, "w", encoding="utf-8") as f:
                json.dump({"entry": script.replace("\\", "/"), "args": sys.argv[1:], "events": events}, f, ensure_ascii=False, indent=2)
    sys.exit(code)


if __name__ == "__main__":
    main()
