#!/usr/bin/env python3
"""Native, repository-local installation and process management. Python 3.12."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
CONFIG = LOCAL / "settings.json"
PIDFILE = LOCAL / "run" / "supervisor.json"
PORTS = {"stt": 8766, "llm": 8768, "portfolio": 8769, "tts": 8770}


def manifest():
    return json.loads((ROOT / "assets.lock.json").read_text())


def read_settings():
    if not CONFIG.is_file():
        raise RuntimeError("Not installed. Run ./setup.sh first.")
    return json.loads(CONFIG.read_text())


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(asset, destination):
    """Atomic verified downloads. Existing files are verified before reuse."""
    destination = Path(destination)
    if destination.is_file() and destination.stat().st_size == asset["size"]:
        if sha256(destination) == asset["sha256"]:
            print(f"Verified: {destination.name}", flush=True)
            return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    print(f"Downloading {destination.name} ({asset['size'] / 1e6:.1f} MB)", flush=True)
    try:
        request = urllib.request.Request(asset["url"], headers={"User-Agent": "real-estate-voice-assistant/0.1"})
        with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target, length=1024 * 1024)
        if temporary.stat().st_size != asset["size"] or sha256(temporary) != asset["sha256"]:
            raise RuntimeError(f"Integrity check failed for {destination.name}; file not installed.")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def command(args, **kwargs):
    print("+ " + " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), check=True, **kwargs)


def checkout(spec, folder):
    """Third-party source remains under ignored .local/, pinned to a commit."""
    folder = Path(folder)
    if not (folder / ".git").is_dir():
        command(["git", "clone", "--filter=blob:none", "--no-checkout", spec["url"], folder])
    origin = subprocess.check_output(["git", "-C", str(folder), "remote", "get-url", "origin"], text=True).strip()
    if origin != spec["url"]:
        raise RuntimeError(f"Unexpected upstream in {folder}; refusing to reuse it.")
    command(["git", "-C", folder, "fetch", "--depth", "1", "origin", spec["revision"]])
    command(["git", "-C", folder, "checkout", "--detach", spec["revision"]])
    actual = subprocess.check_output(["git", "-C", str(folder), "rev-parse", "HEAD"], text=True).strip()
    if actual != spec["revision"]:
        raise RuntimeError(f"Unexpected source revision in {folder}.")


def install(args):
    lock = manifest()
    profile = args.backend
    if profile == "auto":
        profile = "metal" if platform.system() == "Darwin" and platform.machine() == "arm64" else "cpu"
    enabled_models = [key for key in lock["models"] if args.with_tts or key not in {"freya", "freya_config", "audiovae"}]
    plan = {"platform": platform.system(), "backend": profile, "tts": args.with_tts,
            "local_directory": str(LOCAL), "download_bytes": sum(lock["models"][key]["size"] for key in enabled_models),
            "assets": enabled_models, "runtime_revisions": {key: val["revision"] for key, val in lock["runtimes"].items()}}
    if args.dry_run:
        print(json.dumps(plan, indent=2))
        return
    if platform.system() != "Darwin":
        raise RuntimeError("This first installer supports macOS only. Linux deployment has not been validated.")
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("Use Python 3.12: PYTHON=python3.12 ./setup.sh")
    if profile == "metal" and platform.machine() != "arm64":
        raise RuntimeError("The Metal profile currently targets Apple Silicon. Use --backend cpu.")
    for tool in ("git", "cmake", "clang"):
        if not shutil.which(tool):
            raise RuntimeError(f"Missing {tool}. See README prerequisites; no system packages are installed automatically.")
    LOCAL.mkdir(exist_ok=True)
    for env_name, requirements in [("venv", "requirements.txt"), *([("tts-venv", "requirements-tts.txt")] if args.with_tts else [])]:
        env = LOCAL / env_name
        if not (env / "bin" / "python").is_file():
            venv.EnvBuilder(with_pip=True).create(env)
        command([env / "bin/python", "-m", "pip", "install", "-r", ROOT / requirements])
    for key in ("llama", "whisper"):
        spec = lock["runtimes"][key]
        source = LOCAL / "sources" / key
        source.parent.mkdir(exist_ok=True)
        checkout(spec, source)
        build = LOCAL / "build" / f"{key}-{profile}"
        command(["cmake", "-S", source, "-B", build, "-DCMAKE_BUILD_TYPE=Release",
                 "-DGGML_METAL=" + ("ON" if profile == "metal" else "OFF"), "-DGGML_CUDA=OFF"])
        command(["cmake", "--build", build, "--config", "Release", "--parallel", str(args.jobs), "--target", spec["target"]])
        if not (build / "bin" / spec["target"]).is_file():
            raise RuntimeError(f"Build succeeded but {spec['target']} was not found.")
    if args.with_tts:
        checkout(lock["runtimes"]["freya"], LOCAL / "sources" / "freya")
    for key in enabled_models:
        asset = lock["models"][key]
        download(asset, LOCAL / "models" / asset["path"])
    settings = {"backend": profile, "tts": args.with_tts, "tts_device": args.tts_device,
                "threads": args.threads, "asset_schema_version": lock["schema_version"]}
    temporary = CONFIG.with_suffix(".tmp")
    temporary.write_text(json.dumps(settings, indent=2) + "\n")
    temporary.replace(CONFIG)
    print("Installation complete. Run ./run.sh; stop with Ctrl+C or ./stop.sh.")


def service_specs(settings):
    profile = settings["backend"]
    py = LOCAL / "venv/bin/python"
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    # All runtime assets are local. No model hub access is needed while serving.
    env.update(WHISPER_CPP_BIN=str(LOCAL / f"build/whisper-{profile}/bin/whisper-cli"),
               WHISPER_MODEL=str(LOCAL / "models/whisper/model.bin"),
               SILERO_VAD_MODEL=str(LOCAL / "models/silero/model.onnx"),
               WHISPER_THREADS=str(settings["threads"]), WHISPER_USE_GPU="1" if profile == "metal" else "0")
    llama = [str(LOCAL / f"build/llama-{profile}/bin/llama-server"), "--model", str(LOCAL / "models/qwen/model.gguf"),
             "--alias", "qwen3-real-estate", "--ctx-size", "4096", "--threads", str(settings["threads"]),
             "--host", "127.0.0.1", "--port", str(PORTS["llm"]), "--cors-origins", "localhost"]
    llama += ["--n-gpu-layers", "99"] if profile == "metal" else ["--device", "none", "--n-gpu-layers", "0"]
    specs = [("llm", llama, env)]
    for name in ("portfolio", "stt"):
        specs.append((name, [str(py), "-m", "uvicorn", "--app-dir", str(ROOT / "services" / name), "app:app",
                             "--host", "127.0.0.1", "--port", str(PORTS[name])], env))
    if settings["tts"]:
        tts_env = dict(env, TTS_DEVICE=settings["tts_device"], FREYA_SOURCE=str(LOCAL / "sources/freya"),
                       FREYA_MODEL_DIR=str(LOCAL / "models/freya"), FREYA_VAE_PATH=str(LOCAL / "models/freya/audiovae.pth"))
        specs.append(("tts", [str(LOCAL / "tts-venv/bin/python"), "-m", "uvicorn", "--app-dir", str(ROOT / "services/tts"),
                             "app:app", "--host", "127.0.0.1", "--port", str(PORTS["tts"])], tts_env))
    return specs


def occupied(port):
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return False
        except OSError:
            return True


def owns_pid(pid):
    try:
        cmd = subprocess.check_output(["ps", "-p", str(pid), "-o", "command="], text=True).strip()
        return str(Path(__file__).resolve()) in cmd and " start" in cmd
    except (subprocess.CalledProcessError, ProcessLookupError):
        return False


def start(_args):
    settings = read_settings()
    specs = service_specs(settings)
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)
    installation_lock = (PIDFILE.parent / "supervisor.lock").open("a")
    try:
        fcntl.flock(installation_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        installation_lock.close()
        raise RuntimeError("This installation is already running.")
    if PIDFILE.is_file() and owns_pid(json.loads(PIDFILE.read_text())["pid"]):
        raise RuntimeError("This installation is already running.")
    for name, _, _ in specs:
        if occupied(PORTS[name]):
            raise RuntimeError(f"Port {PORTS[name]} is occupied ({name}). Stop the existing demo yourself; no process was killed.")
    PIDFILE.parent.mkdir(parents=True, exist_ok=True)
    # The held advisory lock serializes supervisors; stale PID metadata is replaceable.
    PIDFILE.unlink(missing_ok=True)
    children, logs = [], []
    stopping = False

    def handle_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    previous = {sig: signal.signal(sig, handle_stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        with PIDFILE.open("x") as target:
            json.dump({"pid": os.getpid(), "root": str(ROOT)}, target)
        for name, args, env in specs:
            log = (PIDFILE.parent / f"{name}.log").open("ab")
            logs.append(log)
            children.append((name, subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)))
        print("Services starting: http://127.0.0.1:8766 — use ./status.sh to check readiness.", flush=True)
        print("Keep this terminal open. Logs: .local/run/. Ctrl+C stops this installation.", flush=True)
        while not stopping:
            for name, child in children:
                if child.poll() is not None:
                    raise RuntimeError(f"{name} exited with code {child.returncode}. See .local/run/{name}.log. Other services will stop.")
            time.sleep(0.3)
    finally:
        for _, child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for _, child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        for log in logs:
            log.close()
        if PIDFILE.is_file():
            recorded = json.loads(PIDFILE.read_text())
            if recorded.get("pid") == os.getpid():
                PIDFILE.unlink()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        installation_lock.close()


def stop(_args):
    if not PIDFILE.is_file():
        print("No running supervisor recorded for this installation.")
        return
    pid = json.loads(PIDFILE.read_text())["pid"]
    if not owns_pid(pid):
        PIDFILE.unlink()
        print("Removed a stale pid record; no process was signalled.")
        return
    os.kill(pid, signal.SIGTERM)
    print("Stop requested. The supervisor will shut down only its own services.")


def status(_args):
    settings = read_settings()
    if not PIDFILE.is_file() or not owns_pid(json.loads(PIDFILE.read_text())["pid"]):
        print(json.dumps({"running": False, "detail": "No active supervisor for this installation."}))
        return 1
    results = {}
    for name, _, _ in service_specs(settings):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORTS[name]}/health", timeout=3) as response:
                results[name] = {"ready": response.status == 200, "health": json.load(response)}
        except (OSError, ValueError, urllib.error.HTTPError) as exc:
            results[name] = {"ready": False, "detail": str(exc)}
    print(json.dumps(results, indent=2))
    return 0 if all(result["ready"] for result in results.values()) else 1


def verify(_args):
    settings = read_settings()
    failures = []
    for name, asset in manifest()["models"].items():
        if not settings["tts"] and name in {"freya", "freya_config", "audiovae"}:
            continue
        path = LOCAL / "models" / asset["path"]
        valid = path.is_file() and path.stat().st_size == asset["size"] and sha256(path) == asset["sha256"]
        print(f"{name}: {'verified' if valid else 'missing or invalid'}")
        if not valid:
            failures.append(name)
    return int(bool(failures))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="action", required=True)
    setup = subs.add_parser("install", help="Build native runtimes and download external assets")
    setup.add_argument("--backend", choices=("auto", "cpu", "metal"), default="auto")
    setup.add_argument("--with-tts", action="store_true", help="Also install FreyaTTS and AudioVAE (optional, heavier dependencies)")
    setup.add_argument("--tts-device", choices=("cpu", "mps"), default="cpu", help="MPS is optional and must be evaluated on your Mac")
    setup.add_argument("--threads", type=int, default=6)
    setup.add_argument("--jobs", type=int, default=2, help="Native build concurrency; does not affect inference threads")
    setup.add_argument("--dry-run", action="store_true", help="Print plan without changing files or downloading anything")
    for action in ("start", "stop", "status", "verify"):
        subs.add_parser(action)
    args = parser.parse_args(argv)
    if args.action == "install" and (args.threads < 1 or args.jobs < 1):
        parser.error("--threads and --jobs must be positive")
    try:
        return globals()[args.action](args) or 0
    except (RuntimeError, OSError, subprocess.CalledProcessError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
