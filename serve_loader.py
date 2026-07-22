#!/usr/bin/env python3
"""Serve the loader with no-cache headers so a reinstall always gets the fresh
file — plain `python -m http.server` lets Chrome cache the loader page, which
made a TM reinstall re-offer the OLD loader (v.30 stale-loader incident,
2026-07-22). Run: python3 serve_loader.py  (Ctrl-C to stop)."""
import http.server
import socketserver
from pathlib import Path

PORT = 8799
DIRECTORY = str(Path(__file__).resolve().parent)


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


class ReuseTCPServer(socketserver.TCPServer):
    allow_reuse_address = True   # avoid Errno 98 on a quick restart (TIME_WAIT)


with ReuseTCPServer(('127.0.0.1', PORT), NoCacheHandler) as httpd:
    print(f'Serving {DIRECTORY} at http://127.0.0.1:{PORT}/ (no-cache)')
    httpd.serve_forever()
