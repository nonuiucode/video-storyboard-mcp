#!/usr/bin/env python3
"""Minimal OpenAI-compatible local ASR HTTP server for video-storyboard.

Implements:
  GET  /health
  GET  /v1/models
  POST /shutdown
  POST /v1/audio/transcriptions  (also /audio/transcriptions)

Uses pure Python stdlib for HTTP, multipart parsing, and WAV decoding, plus
optional sherpa-onnx (SenseVoice / Paraformer + Silero VAD + optional punctuation).
Supports `--mock` mode for zero-weight offline end-to-end testing.
"""

from __future__ import annotations

import argparse
import array
import io
import json
import os
import re
import sys
import threading
import wave
from email.parser import BytesParser
from email.policy import default as email_policy_default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TARGET_SR = 16000
_SPECIAL_TAG_RE = re.compile(r"<\|[^|>]+\|>")


def decode_wav_to_16k_mono(wav_bytes: bytes) -> tuple[list[float], float]:
    """Decode PCM16 WAV bytes into normalized 16 kHz mono float samples and duration."""
    if not wav_bytes or len(wav_bytes) < 44:
        raise ValueError("Invalid or empty WAV payload")
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        framerate = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if sampwidth != 2:
        raise ValueError(f"Unsupported WAV sample width: {sampwidth * 8}-bit (expected 16-bit PCM)")
    if nchannels < 1 or framerate <= 0:
        raise ValueError(f"Invalid WAV stream geometry: channels={nchannels}, rate={framerate}")

    pcm = array.array("h")
    pcm.frombytes(raw[: len(raw) - (len(raw) % 2)])
    if sys.byteorder != "little":
        pcm.byteswap()

    if nchannels == 1:
        mono = [v / 32768.0 for v in pcm]
    else:
        total_frames = len(pcm) // nchannels
        mono = [
            sum(pcm[i * nchannels + ch] for ch in range(nchannels)) / (nchannels * 32768.0)
            for i in range(total_frames)
        ]

    if framerate != TARGET_SR and len(mono) > 1:
        mono = _linear_resample(mono, framerate, TARGET_SR)

    duration = len(mono) / float(TARGET_SR)
    return mono, duration


def _linear_resample(samples: list[float], src_rate: int, dst_rate: int) -> list[float]:
    if src_rate == dst_rate or len(samples) < 2:
        return samples
    out_len = max(1, int(round(len(samples) * dst_rate / src_rate)))
    ratio = (len(samples) - 1) / float(max(1, out_len - 1)) if out_len > 1 else 0.0
    out: list[float] = []
    max_idx = len(samples) - 1
    for i in range(out_len):
        pos = i * ratio
        lo = int(pos)
        hi = min(max_idx, lo + 1)
        frac = pos - lo
        out.append(samples[lo] * (1.0 - frac) + samples[hi] * frac)
    return out


def parse_multipart_form(content_type: str, body: bytes) -> tuple[dict[str, str], bytes | None]:
    """Parse multipart/form-data request body using stdlib email parser."""
    if "multipart/form-data" not in (content_type or "").lower():
        raise ValueError("Content-Type must be multipart/form-data")
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    msg = BytesParser(policy=email_policy_default).parsebytes(header + body)
    if not msg.is_multipart():
        raise ValueError("Malformed multipart/form-data body")

    fields: dict[str, str] = {}
    file_bytes: bytes | None = None
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            raw_txt = part.get_payload()
            payload = raw_txt.encode("utf-8", errors="replace") if isinstance(raw_txt, str) else b""
        if name == "file":
            file_bytes = payload
        else:
            fields[name] = payload.decode("utf-8", errors="replace").strip()
    return fields, file_bytes


def _clean_text(text: str) -> str:
    cleaned = _SPECIAL_TAG_RE.sub("", text or "")
    return " ".join(cleaned.split()).strip()


def _pick_existing_file(directory: Path, names: tuple[str, ...]) -> Path:
    for name in names:
        cand = directory / name
        if cand.is_file():
            return cand
    raise FileNotFoundError(f"None of {names} found in {directory}")


class AsrRuntime:
    """Loaded sherpa-onnx recognizer (or mock runtime) shared across requests."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.engine = args.engine
        self.mock = bool(args.mock)
        self.language = args.language or "auto"
        self.threads = max(1, int(args.threads))
        self.vad_path = Path(args.vad) if args.vad else None
        self.model_id = "mock-sherpa-asr" if self.mock else f"sherpa-{args.engine}"
        self._lock = threading.Lock()
        self._sherpa = None
        self._recognizer = None
        self._punct = None

        if not self.mock:
            self._load_sherpa(args)

    def _load_sherpa(self, args: argparse.Namespace) -> None:
        import sherpa_onnx  # type: ignore

        if not args.model_dir:
            raise ValueError("--model-dir is required unless --mock is set")
        model_dir = Path(args.model_dir)
        if not model_dir.is_dir():
            raise FileNotFoundError(f"Model directory not found: {model_dir}")

        model_file = _pick_existing_file(model_dir, ("model.int8.onnx", "model.onnx"))
        tokens_file = _pick_existing_file(model_dir, ("tokens.txt",))

        if self.engine == "sensevoice":
            lang_hint = "" if self.language in ("", "auto") else self.language
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(model_file),
                tokens=str(tokens_file),
                language=lang_hint,
                use_itn=True,
                num_threads=self.threads,
                debug=False,
            )
            self.model_id = "sherpa-sensevoice-int8"
        elif self.engine == "paraformer":
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
                paraformer=str(model_file),
                tokens=str(tokens_file),
                num_threads=self.threads,
                debug=False,
            )
            self.model_id = "sherpa-paraformer"
            if args.punct_dir:
                punct_dir = Path(args.punct_dir)
                if punct_dir.is_dir():
                    punct_model = _pick_existing_file(punct_dir, ("model.int8.onnx", "model.onnx"))
                    p_cfg = sherpa_onnx.OfflinePunctuationConfig(
                        model=sherpa_onnx.OfflinePunctuationModelConfig(
                            ct_transformer=str(punct_model),
                            num_threads=1,
                            debug=False,
                        )
                    )
                    self._punct = sherpa_onnx.OfflinePunctuation(p_cfg)
        else:
            raise ValueError(f"Unsupported engine: {self.engine}")

        if self.vad_path and not self.vad_path.is_file():
            self.vad_path = None
        self._sherpa = sherpa_onnx

    def _decode_chunk(self, samples: list[float]) -> str:
        with self._lock:
            stream = self._recognizer.create_stream()
            stream.accept_waveform(TARGET_SR, samples)
            self._recognizer.decode_stream(stream)
            text = _clean_text(getattr(stream.result, "text", "") or "")
            if text and self._punct is not None:
                try:
                    text = _clean_text(self._punct.add_punctuation(text))
                except Exception:
                    pass
            return text

    def transcribe(self, samples: list[float], duration: float, language: str) -> dict:
        lang = language or (self.language if self.language != "auto" else "zh")
        if self.mock:
            text = "mock local asr transcript"
            return {
                "text": text,
                "model": self.model_id,
                "language": lang,
                "segments": [
                    {
                        "start": 0.0,
                        "end": round(max(0.01, duration), 2),
                        "text": text,
                    }
                ],
            }

        segments: list[dict] = []
        if self.vad_path is not None and self._sherpa is not None and duration > 0.25:
            vad_cfg = self._sherpa.VadModelConfig()
            vad_cfg.silero_vad.model = str(self.vad_path)
            vad_cfg.silero_vad.threshold = 0.5
            vad_cfg.silero_vad.min_silence_duration = 0.4
            vad_cfg.silero_vad.min_speech_duration = 0.2
            vad_cfg.sample_rate = TARGET_SR
            vad = self._sherpa.VoiceActivityDetector(vad_cfg, buffer_size_in_seconds=60)

            win_size = 512
            for pos in range(0, len(samples), win_size):
                chunk = samples[pos : pos + win_size]
                if len(chunk) < win_size:
                    chunk = chunk + [0.0] * (win_size - len(chunk))
                vad.accept_waveform(chunk)
                while not vad.empty():
                    seg = vad.front
                    vad.pop()
                    seg_text = self._decode_chunk(list(seg.samples))
                    if seg_text:
                        t0 = round(max(0.0, seg.start / float(TARGET_SR)), 3)
                        t1 = round(min(duration, (seg.start + len(seg.samples)) / float(TARGET_SR)), 3)
                        if t1 > t0:
                            segments.append({"start": t0, "end": t1, "text": seg_text})

            vad.flush()
            while not vad.empty():
                seg = vad.front
                vad.pop()
                seg_text = self._decode_chunk(list(seg.samples))
                if seg_text:
                    t0 = round(max(0.0, seg.start / float(TARGET_SR)), 3)
                    t1 = round(min(duration, (seg.start + len(seg.samples)) / float(TARGET_SR)), 3)
                    if t1 > t0:
                        segments.append({"start": t0, "end": t1, "text": seg_text})

        if not segments and samples:
            full_text = self._decode_chunk(samples)
            if full_text:
                segments.append({"start": 0.0, "end": round(max(0.01, duration), 3), "text": full_text})

        combined = " ".join(s["text"] for s in segments).strip()
        return {
            "text": combined,
            "model": self.model_id,
            "language": lang,
            "segments": segments,
        }


def make_handler(runtime: AsrRuntime):
    class AsrHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args) -> None:
            sys.stderr.write(f"[asr_server] {format % args}\n")

        def _send_json(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/health":
                self._send_json(200, {"status": "ok", "model": runtime.model_id, "engine": runtime.engine})
                return
            if path in ("/v1/models", "/models"):
                self._send_json(
                    200,
                    {
                        "object": "list",
                        "data": [{"id": runtime.model_id, "object": "model", "owned_by": "local"}],
                    },
                )
                return
            self._send_json(404, {"error": f"Not found: {path}"})

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/shutdown":
                self._send_json(200, {"status": "shutting_down"})
                srv = self.server
                threading.Thread(target=srv.shutdown, daemon=True).start()
                return

            if path not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                self._send_json(404, {"error": f"Not found: {path}"})
                return

            try:
                content_len = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                self._send_json(400, {"error": "Invalid Content-Length"})
                return
            if content_len <= 0:
                self._send_json(400, {"error": "Empty request body"})
                return

            body = self.rfile.read(content_len)
            content_type = self.headers.get("Content-Type", "")
            try:
                fields, file_bytes = parse_multipart_form(content_type, body)
                if not file_bytes:
                    raise ValueError("Missing 'file' field in multipart upload")
                samples, duration = decode_wav_to_16k_mono(file_bytes)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
                return
            except Exception as exc:
                self._send_json(400, {"error": f"Failed to decode audio: {exc}"})
                return

            try:
                lang = fields.get("language") or "zh"
                result = runtime.transcribe(samples, duration, lang)
                self._send_json(200, result)
            except Exception as exc:
                sys.stderr.write(f"[asr_server] transcribe error: {exc}\n")
                self._send_json(500, {"error": str(exc)})

    return AsrHandler


def main() -> int:
    parser = argparse.ArgumentParser(description="Local OpenAI-compatible sherpa-onnx ASR server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18321)
    parser.add_argument("--engine", choices=("sensevoice", "paraformer"), default="sensevoice")
    parser.add_argument("--model-dir", default="")
    parser.add_argument("--vad", default="")
    parser.add_argument("--punct-dir", default="")
    parser.add_argument("--language", default="auto")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--mock", action="store_true", help="Run without model weights for smoke testing")
    args = parser.parse_args()

    runtime = AsrRuntime(args)
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((args.host, args.port), make_handler(runtime))
    bound_port = server.server_address[1]
    sys.stderr.write(
        f"[asr_server] listening on http://{args.host}:{bound_port} (engine={args.engine}, model={runtime.model_id})\n"
    )
    sys.stderr.flush()
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
