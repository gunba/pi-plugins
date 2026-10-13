#!/usr/bin/env python3
"""Desk dictation: transcribe recorded clips with faster-whisper.

Desk starts this with the Python of a faster-whisper installation and stops it after a few idle minutes.
It reads one JSON request per line on stdin, {"id", "path", "language"?}, and answers each on stdout with
{"id", "text", "language", "seconds"} or {"id", "error"}. The first line it prints is {"ready": true}.
Settings come from the environment: PI_DESK_WHISPER_MODEL, PI_DESK_WHISPER_DEVICE, PI_DESK_WHISPER_MODELS.
"""
import glob
import json
import os
import site
import sys
import time

# CUDA libraries installed as pip packages (nvidia-cublas-cu12, nvidia-cudnn-cu12) are only found by the dynamic
# loader through LD_LIBRARY_PATH, which is read at process start, so restart once with it set.
if sys.platform.startswith("linux") and not os.environ.get("PI_DESK_WHISPER_LIBS"):
    libraries = [path for base in site.getsitepackages() for path in glob.glob(os.path.join(base, "nvidia", "*", "lib"))]
    environment = dict(os.environ, PI_DESK_WHISPER_LIBS="1",
                       LD_LIBRARY_PATH=":".join(libraries + [os.environ.get("LD_LIBRARY_PATH", "")]).strip(":"))
    os.execve(sys.executable, [sys.executable] + sys.argv, environment)

from faster_whisper import WhisperModel  # noqa: E402

device = os.environ.get("PI_DESK_WHISPER_DEVICE", "cuda")
model = WhisperModel(os.environ.get("PI_DESK_WHISPER_MODEL", "large-v3-turbo"), device=device,
                     compute_type="float16" if device == "cuda" else "int8",
                     download_root=os.environ.get("PI_DESK_WHISPER_MODELS") or None)


def reply(value):
    sys.stdout.write(json.dumps(value) + "\n")
    sys.stdout.flush()


reply({"ready": True})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        started = time.time()
        segments, info = model.transcribe(request["path"], language=request.get("language") or None,
                                          beam_size=5, vad_filter=True)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        reply({"id": request.get("id"), "text": text, "language": info.language, "seconds": round(time.time() - started, 2)})
    except Exception as error:  # A bad clip must not stop the server.
        reply({"id": request.get("id"), "error": str(error)[:500]})
