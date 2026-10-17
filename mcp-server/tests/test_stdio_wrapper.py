#!/usr/bin/env python3
"""End-to-end tests for the MCP stdio wrapper.

Runs stdio_wrapper.py as a subprocess speaking MCP over stdin/stdout, against
a fake HTTP backend that returns canned tool results. No browser needed.

    python3 -m unittest discover -s mcp-server/tests -v
"""

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

WRAPPER = Path(__file__).resolve().parent.parent / 'stdio_wrapper.py'

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def make_png(width, height):
    """A noisy PNG (noise keeps it from compressing to nothing)."""
    if HAS_PIL:
        img = Image.frombytes('RGB', (width, height), os.urandom(width * height * 3))
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        return buf.getvalue()
    # 1x1 PNG fallback
    return base64.b64decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==')


FAVICON = 'data:image/png;base64,' + base64.b64encode(make_png(64, 64)).decode()


class FakeBackend(BaseHTTPRequestHandler):
    responses = {}
    calls = []

    def log_message(self, *args):
        pass

    def _send(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/health':
            self._send({'status': 'ok'})
        elif self.path == '/mcp/tools':
            self._send({'tools': [{'name': n, 'inputSchema': {'type': 'object'}}
                                  for n in self.responses]})

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        FakeBackend.calls.append(req)
        self._send(self.responses[req['name']])


class StdioWrapperTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        big_png = make_png(2400, 1500)
        cls.shot_file = Path(cls.tmp.name) / 'shot.png'
        cls.shot_file.write_bytes(big_png)
        small_png = make_png(320, 200)

        FakeBackend.responses = {
            # save_to_file=false path: raw data URI from the extension
            'browser_screenshot': {
                'success': True, 'type': 'visible',
                'data': 'data:image/png;base64,' + base64.b64encode(big_png).decode(),
                'tab': {'id': 7, 'url': 'https://example.com/', 'title': 'Example'}},
            # default path: saved to file, only a path in the result
            'browser_audit_page': {
                'success': True, 'audit': {'title': 'Example'},
                'screenshot': str(cls.shot_file)},
            'browser_screenshot_all_tabs': {
                'success': True, 'count': 2, 'failed': 0, 'screenshots': [
                    {'success': True, 'tabId': i, 'url': f'https://e{i}.com/',
                     'data': 'data:image/png;base64,' + base64.b64encode(small_png).decode()}
                    for i in (1, 2)]},
            'browser_get_tabs': {
                'success': True, 'tabs': [
                    {'id': 1, 'url': 'https://a.com/', 'title': 'A', 'favIconUrl': FAVICON},
                    {'id': 2, 'url': 'https://b.com/', 'title': 'B', 'favIconUrl': FAVICON}]},
            'browser_execute_script': {
                'success': True, 'result': 'data:image/png;base64,' + 'A' * 50000},
        }
        cls.httpd = HTTPServer(('127.0.0.1', 0), FakeBackend)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

        env = dict(os.environ, CLAUDE_BROWSER_HTTP_PORT=str(cls.httpd.server_port))
        cls.proc = subprocess.Popen(
            [sys.executable, str(WRAPPER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, env=env)
        cls.next_id = 0
        init = cls.rpc('initialize', {'protocolVersion': '2024-11-05', 'capabilities': {},
                                      'clientInfo': {'name': 'test', 'version': '0'}})
        assert 'result' in init, init

    @classmethod
    def tearDownClass(cls):
        cls.proc.stdin.close()
        cls.proc.wait(timeout=5)
        cls.httpd.shutdown()
        cls.tmp.cleanup()

    @classmethod
    def rpc(cls, method, params):
        cls.next_id += 1
        cls.proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': cls.next_id,
                                         'method': method, 'params': params}) + '\n')
        cls.proc.stdin.flush()
        return json.loads(cls.proc.stdout.readline())

    def call(self, name, args=None):
        resp = self.rpc('tools/call', {'name': name, 'arguments': args or {}})
        return resp['result']['content']

    def assert_no_blob(self, text):
        self.assertNotIn('base64,', text)
        self.assertLess(len(text), 5000, 'text block should stay small')

    def test_screenshot_returns_image_block(self):
        content = self.call('browser_screenshot', {'save_to_file': False})
        self.assertEqual(content[0]['type'], 'text')
        self.assert_no_blob(content[0]['text'])
        images = [c for c in content if c['type'] == 'image']
        self.assertEqual(len(images), 1)
        img = images[0]
        self.assertIn(img['mimeType'], ('image/png', 'image/jpeg'))
        self.assertFalse(img['data'].startswith('data:'))
        raw = base64.b64decode(img['data'])
        meta = json.loads(content[0]['text'])['images'][0]
        self.assertEqual(meta['tab_id'], 7)
        self.assertEqual(meta['url'], 'https://example.com/')
        if HAS_PIL:
            self.assertLessEqual(len(img['data']), 1_000_000)
            w, h = Image.open(io.BytesIO(raw)).size
            self.assertLessEqual(max(w, h), 1600)
            self.assertEqual((meta['original_width'], meta['original_height']), (2400, 1500))

    def test_audit_screenshot_file_attached(self):
        content = self.call('browser_audit_page')
        self.assertEqual([c['type'] for c in content], ['text', 'image'])
        meta = json.loads(content[0]['text'])
        self.assertEqual(meta['screenshot'], str(self.shot_file))
        self.assertEqual(meta['images'][0]['filepath'], str(self.shot_file))

    def test_all_tabs_images(self):
        content = self.call('browser_screenshot_all_tabs', {'include_data': True})
        self.assertEqual([c['type'] for c in content], ['text', 'image', 'image'])
        self.assert_no_blob(content[0]['text'])

    def test_get_tabs_strips_favicon_by_default(self):
        text = self.call('browser_get_tabs')[0]['text']
        self.assertNotIn('favIconUrl', text)
        self.assert_no_blob(text)

    def test_get_tabs_keeps_favicon_when_requested(self):
        text = self.call('browser_get_tabs', {'include_favicon': True})[0]['text']
        tabs = json.loads(text)['tabs']
        self.assertEqual(tabs[0]['favIconUrl'], FAVICON)

    def test_other_data_uris_scrubbed(self):
        content = self.call('browser_execute_script', {'script': 'x'})
        self.assertEqual(len(content), 1)
        self.assert_no_blob(content[0]['text'])
        self.assertIn('data URI omitted', content[0]['text'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
