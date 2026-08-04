#!/usr/bin/env python3
import argparse
import json
import mimetypes
import ssl
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


class RangeHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def translate_path(self, path: str) -> str:
        relative = unquote(urlsplit(path).path).lstrip("/")
        candidate = (self.server.root / relative).resolve()
        if self.server.root not in candidate.parents and candidate != self.server.root:
            return str(self.server.root / "__denied__")
        return str(candidate)

    def do_HEAD(self):
        self._serve(False)

    def do_GET(self):
        self._serve(True)

    def _serve(self, send_body: bool):
        started = time.monotonic()
        if self.server.latency_ms:
            time.sleep(self.server.latency_ms / 1000)
        path = Path(self.translate_path(self.path))
        if not path.is_file():
            self.send_error(404)
            return
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        range_header = self.headers.get("Range")
        if range_header:
            try:
                unit, value = range_header.split("=", 1)
                if unit != "bytes" or "," in value:
                    raise ValueError()
                first, last = value.split("-", 1)
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                else:
                    start = max(0, size - int(last))
                end = min(end, size - 1)
                if start > end:
                    raise ValueError()
                status = 206
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        sent = 0
        completed = not send_body
        if send_body:
            try:
                with path.open("rb") as source:
                    source.seek(start)
                    remaining = length
                    next_progress = 1024 * 1024
                    while remaining:
                        block = source.read(min(64 * 1024, remaining))
                        if not block:
                            break
                        self.wfile.write(block)
                        sent += len(block)
                        remaining -= len(block)
                        if self.server.bytes_per_second:
                            target_elapsed = sent / self.server.bytes_per_second
                            actual_elapsed = time.monotonic() - started - self.server.latency_ms / 1000
                            if target_elapsed > actual_elapsed:
                                time.sleep(target_elapsed - actual_elapsed)
                        if sent >= next_progress:
                            self._write_event(path, status, range_header, sent, size, started, False, "progress")
                            next_progress += 1024 * 1024
                    completed = remaining == 0
            except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
                completed = False
        self._write_event(path, status, range_header, sent, size, started, completed, "complete")

    def _write_event(self, path, status, range_header, sent, size, started, completed, event_type):
        event = {
            "time": time.time(),
            "elapsedMs": round((time.monotonic() - started) * 1000, 3),
            "event": event_type,
            "method": self.command,
            "path": path.name,
            "status": status,
            "range": range_header,
            "bytes": sent,
            "size": size,
            "completed": completed,
            "userAgent": self.headers.get("User-Agent"),
            "qualificationHeader": self.headers.get("X-Tauri-Video-Qualification"),
            "cookie": self.headers.get("Cookie"),
            "referer": self.headers.get("Referer"),
        }
        with self.server.log_path.open("a", encoding="utf-8") as log:
            log.write(json.dumps(event) + "\n")

    def log_message(self, message, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--port", type=int, default=9443)
    parser.add_argument("--bytes-per-second", type=int, default=0)
    parser.add_argument("--latency-ms", type=int, default=0)
    args = parser.parse_args()
    root = args.root.resolve()
    args.log.parent.mkdir(parents=True, exist_ok=True)
    args.log.write_text("", encoding="utf-8")
    server = ThreadingHTTPServer(("0.0.0.0", args.port), RangeHandler)
    server.root = root
    server.log_path = args.log.resolve()
    server.bytes_per_second = max(0, args.bytes_per_second)
    server.latency_ms = max(0, args.latency_ms)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"HTTPS range server: https://127.0.0.1:{args.port} -> {root}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
