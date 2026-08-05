# /api/lint-python.py
#
# Real Python syntax validation using CPython's own parser (the `ast`
# module) — not a bracket-balance heuristic. This is the specific gap
# called out earlier: a heuristic checker literally cannot catch a Python
# indentation error, a missing colon after `if`/`def`/`for`, or any of the
# dozens of syntax rules that are specific to Python's grammar, because
# it isn't parsing Python's grammar at all — just counting brackets/quotes.
# ast.parse() IS Python's real grammar, running as the actual language spec
# defines it.
#
# ast.parse() only parses down to an abstract syntax tree — it never
# compiles to bytecode and never executes anything, so this is exactly as
# safe as the existing "compile, don't run" checks (new Function() client-
# side, esbuild.transformSync in lint-code.js): arbitrary AI-generated
# Python passed in here cannot run any code, import anything, or touch the
# filesystem/network.
#
# Vercel auto-detects this as a Python runtime function purely from the
# .py extension living under /api — no vercel.json or extra config needed
# alongside the existing .js functions in this same folder. Uses only the
# Python standard library (ast, json) so there's nothing to add to
# requirements.txt.

from http.server import BaseHTTPRequestHandler
import ast
import json

# Same allowed origin as lib/cors.js — kept as a plain literal here since
# Python functions in this project can't import the Node lib/ helpers.
ALLOWED_ORIGIN = 'https://cavdo.qd.je'

MAX_SNIPPETS = 20
MAX_SNIPPET_BYTES = 300000  # matches lint-code.js's per-snippet cap


class handler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self._cors_headers()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # CORS preflight — mirrors applyCors()'s OPTIONS handling in
        # lib/cors.js so the browser's preflight check passes identically.
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length) if length else b''
        try:
            body = json.loads(raw or b'{}')
        except Exception:
            self._send_json(400, {'error': 'Invalid JSON body'})
            return

        snippets = body.get('snippets') if isinstance(body, dict) else None
        if not isinstance(snippets, list) or not snippets:
            self._send_json(400, {'error': 'Body must be { snippets: [{ id, content }, ...] }'})
            return
        if len(snippets) > MAX_SNIPPETS:
            self._send_json(400, {'error': f'Too many snippets in one request (max {MAX_SNIPPETS})'})
            return

        results = []
        for s in snippets:
            if not isinstance(s, dict):
                continue
            sid = s.get('id')
            content = s.get('content')
            content = content if isinstance(content, str) else ''

            if len(content.encode('utf-8', errors='ignore')) > MAX_SNIPPET_BYTES:
                results.append({'id': sid, 'ok': False, 'message': 'snippet exceeds the 300KB per-snippet limit'})
                continue

            try:
                ast.parse(content)
                results.append({'id': sid, 'ok': True})
            except SyntaxError as e:
                # e.msg/lineno/offset are exactly what Python itself prints
                # in a real traceback — the actual compiler's own diagnosis,
                # not a guess about what might be wrong.
                results.append({
                    'id': sid,
                    'ok': False,
                    'message': e.msg,
                    'line': e.lineno,
                    'column': e.offset,
                })
            except Exception as e:
                # Extremely defensive fallback — ast.parse should only ever
                # raise SyntaxError (or ValueError on things like null
                # bytes), but never let one bad snippet 500 the whole batch.
                results.append({'id': sid, 'ok': False, 'message': str(e)})

        self._send_json(200, {'results': results})
