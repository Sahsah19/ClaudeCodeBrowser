#!/usr/bin/env python3
"""
MCP stdio wrapper for ClaudeCodeBrowser

This wrapper translates between MCP stdio protocol and the HTTP-based browser server.
It handles the JSON-RPC communication that Claude Code expects.
"""

import sys
import io
import re
import base64
import struct
import json
import urllib.request
import urllib.error
import subprocess
import time
import os
import signal
from pathlib import Path
from typing import Optional

# Configuration
HTTP_HOST = os.environ.get('CLAUDE_BROWSER_HOST', '127.0.0.1')
HTTP_PORT = int(os.environ.get('CLAUDE_BROWSER_HTTP_PORT', '8765'))
HTTP_URL = f'http://{HTTP_HOST}:{HTTP_PORT}'

# Server process reference
server_process = None

_TOKEN_FILE = Path.home() / '.claudecodebrowser' / 'api_token'


def _api_headers(extra: Optional[dict] = None) -> dict:
    """Return HTTP headers including the API token if available."""
    headers = {'Content-Type': 'application/json'}
    try:
        if _TOKEN_FILE.exists():
            headers['X-API-Key'] = _TOKEN_FILE.read_text().strip()
    except Exception:
        pass
    if extra:
        headers.update(extra)
    return headers


def log(msg):
    """Log to stderr for debugging."""
    print(f"[stdio_wrapper] {msg}", file=sys.stderr, flush=True)

def start_http_server():
    """Start the HTTP server if not running."""
    global server_process

    # Check if server is already running
    try:
        req = urllib.request.Request(f'{HTTP_URL}/health')
        with urllib.request.urlopen(req, timeout=2) as resp:
            if resp.status == 200:
                log("HTTP server already running")
                return True
    except:
        pass

    # Start the server
    server_script = Path(__file__).parent / 'server.py'
    if not server_script.exists():
        log(f"Server script not found: {server_script}")
        return False

    log(f"Starting HTTP server: {server_script}")
    server_process = subprocess.Popen(
        [sys.executable, str(server_script)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True
    )

    # Wait for server to start
    for _ in range(20):
        time.sleep(0.25)
        try:
            req = urllib.request.Request(f'{HTTP_URL}/health')
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    log("HTTP server started successfully")
                    return True
        except:
            pass

    log("Failed to start HTTP server")
    return False

def get_tools():
    """Fetch available tools from the HTTP server."""
    try:
        req = urllib.request.Request(f'{HTTP_URL}/mcp/tools', headers=_api_headers())
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('tools', [])
    except Exception as e:
        log(f"Error fetching tools: {e}")
        return []

def call_tool(name, arguments):
    """Call a tool via the HTTP server."""
    try:
        data = json.dumps({'name': name, 'arguments': arguments}).encode('utf-8')
        req = urllib.request.Request(
            f'{HTTP_URL}/mcp/call',
            data=data,
            headers=_api_headers()
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        log(f"Error calling tool {name}: {e}")
        return {'success': False, 'error': str(e)}

def read_message():
    """Read a JSON-RPC message from stdin."""
    try:
        line = sys.stdin.readline()
        if not line:
            return None
        return json.loads(line.strip())
    except json.JSONDecodeError as e:
        log(f"JSON decode error: {e}")
        return None
    except Exception as e:
        log(f"Error reading message: {e}")
        return None

def write_message(msg):
    """Write a JSON-RPC message to stdout."""
    try:
        json_str = json.dumps(msg)
        print(json_str, flush=True)
    except Exception as e:
        log(f"Error writing message: {e}")

def handle_initialize(msg):
    """Handle the initialize request."""
    return {
        "jsonrpc": "2.0",
        "id": msg.get("id"),
        "result": {
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "claudecodebrowser",
                "version": "1.0.0"
            }
        }
    }

def handle_tools_list(msg):
    """Handle the tools/list request."""
    tools = get_tools()

    # Convert tools to MCP format
    mcp_tools = []
    for tool in tools:
        mcp_tools.append({
            "name": tool['name'],
            "description": tool.get('description', ''),
            "inputSchema": tool.get('inputSchema', {"type": "object", "properties": {}})
        })

    return {
        "jsonrpc": "2.0",
        "id": msg.get("id"),
        "result": {
            "tools": mcp_tools
        }
    }

# ---------------------------------------------------------------------------
# Result shaping for MCP clients
#
# The HTTP server returns plain JSON. MCP clients (Claude Code, the Claude
# desktop app) can only *see* an image when it arrives as an image content
# block, and base64 inside a text block just burns tokens. So screenshots are
# pulled out into image blocks and any other data: URI / base64 blob is
# stripped from the text. The HTTP API itself is unchanged.
# ---------------------------------------------------------------------------

# Set CLAUDE_BROWSER_MCP_IMAGES=0 to stop attaching image blocks (base64 is
# still kept out of text; the saved file path remains in the result).
MCP_IMAGES = os.environ.get('CLAUDE_BROWSER_MCP_IMAGES', '1') != '0'
IMAGE_MAX_EDGE = int(os.environ.get('CLAUDE_BROWSER_MCP_IMAGE_MAX_EDGE', '1600'))
IMAGE_MAX_B64 = int(os.environ.get('CLAUDE_BROWSER_MCP_IMAGE_MAX_BYTES', '1000000'))
MAX_IMAGES_PER_RESULT = 10
IMAGE_SUFFIXES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'}

try:
    from PIL import Image  # type: ignore
    HAS_PIL = True
except Exception:
    HAS_PIL = False

_BASE64_RE = re.compile(r'^[A-Za-z0-9+/=\s]+$')


def _b64len(n_bytes: int) -> int:
    return 4 * ((n_bytes + 2) // 3)


def _sniff_mime(raw: bytes) -> Optional[str]:
    """Identify an image by its magic bytes."""
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if raw[:3] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if raw[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    return None


def _decode_image_string(value: str):
    """Return (bytes, mime) for an image data: URI or bare base64 string, else None."""
    if not isinstance(value, str) or not value:
        return None
    payload = value.partition(',')[2] if value.startswith('data:') else value
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception:
        return None
    mime = _sniff_mime(raw)
    return (raw, mime) if mime else None


def _png_dimensions(raw: bytes):
    if raw[:8] == b'\x89PNG\r\n\x1a\n' and len(raw) >= 24:
        return struct.unpack('>II', raw[16:24])
    return None


def prepare_image(raw: bytes, mime: str, max_edge: int, max_b64: int) -> dict:
    """Downscale / re-encode an image so it is a sensible size for a model.

    Returns {'data': base64 str, 'mimeType', 'width', 'height',
             'original_width', 'original_height', 'resized', 'note'?}.
    """
    info = {'resized': False}

    if not HAS_PIL:
        dims = _png_dimensions(raw)
        if dims:
            info.update(width=dims[0], height=dims[1],
                        original_width=dims[0], original_height=dims[1])
        info['note'] = 'Pillow not installed; image returned at original size.'
        info.update(data=base64.b64encode(raw).decode('ascii'), mimeType=mime)
        return info

    img = Image.open(io.BytesIO(raw))
    img.load()
    ow, oh = img.size
    info.update(original_width=ow, original_height=oh)

    fits = max(ow, oh) <= max_edge and _b64len(len(raw)) <= max_b64
    if fits and mime in ('image/png', 'image/jpeg'):
        info.update(data=base64.b64encode(raw).decode('ascii'), mimeType=mime,
                    width=ow, height=oh)
        return info

    def encode(im, fmt, quality=80):
        buf = io.BytesIO()
        if fmt == 'JPEG':
            if im.mode not in ('RGB', 'L'):
                im = im.convert('RGB')
            im.save(buf, 'JPEG', quality=quality, optimize=True)
        else:
            im.save(buf, 'PNG', optimize=True)
        return buf.getvalue()

    work = img
    if max(ow, oh) > max_edge:
        work = img.copy()
        work.thumbnail((max_edge, max_edge), Image.LANCZOS)

    out, out_mime = encode(work, 'PNG'), 'image/png'
    if _b64len(len(out)) > max_b64:
        out, out_mime = encode(work, 'JPEG'), 'image/jpeg'
    # Still too big (huge full-page captures): keep shrinking.
    for _ in range(5):
        if _b64len(len(out)) <= max_b64:
            break
        w, h = work.size
        work = work.resize((max(1, int(w * 0.75)), max(1, int(h * 0.75))), Image.LANCZOS)
        out, out_mime = encode(work, 'JPEG'), 'image/jpeg'

    info.update(data=base64.b64encode(out).decode('ascii'), mimeType=out_mime,
                width=work.size[0], height=work.size[1], resized=True)
    return info


def _scrub(value, favicons='scrub'):
    """Recursively replace data: URIs and long base64 blobs with a short note.

    favicons: 'drop' removes favIconUrl keys, 'keep' leaves them untouched
    (explicitly requested), 'scrub' treats them like any other string.
    """
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if k == 'favIconUrl' and favicons == 'drop':
                continue
            out[k] = v if (k == 'favIconUrl' and favicons == 'keep') else _scrub(v, favicons)
        return out
    if isinstance(value, list):
        return [_scrub(v, favicons) for v in value]
    if isinstance(value, str):
        if value.startswith('data:') and (';base64,' in value[:100] or len(value) > 256):
            mime = value[5:].split(',', 1)[0].split(';', 1)[0] or 'unknown'
            return f'[data URI omitted: {mime}, ~{len(value) * 3 // 4 // 1024} KB]'
        if len(value) > 4096 and _BASE64_RE.match(value[:8192]) and ' ' not in value[:200]:
            return f'[base64 data omitted: ~{len(value) * 3 // 4 // 1024} KB]'
    return value


def _load_image_file(path) -> Optional[tuple]:
    try:
        p = Path(path)
        if p.suffix.lower() in IMAGE_SUFFIXES and p.is_file():
            raw = p.read_bytes()
            mime = _sniff_mime(raw)
            if mime:
                return raw, mime
    except Exception as e:
        log(f"Could not read screenshot {path}: {e}")
    return None


def _collect_images(tool_name: str, result: dict) -> list:
    """Find screenshots in a tool result: list of (meta dict, bytes, mime)."""
    found = []
    if not isinstance(result, dict):
        return found

    def add(meta, data=None, filepath=None):
        src = _decode_image_string(data) if isinstance(data, str) else None
        if src is None and filepath:
            src = _load_image_file(filepath)
        if src is not None:
            found.append((meta, src[0], src[1]))

    if tool_name == 'browser_screenshot':
        tab = result.get('tab') or {}
        add({'tab_id': tab.get('id'), 'url': tab.get('url'), 'title': tab.get('title'),
             'filepath': result.get('filepath')},
            data=result.get('data'), filepath=result.get('filepath'))
    elif tool_name == 'browser_screenshot_all_tabs':
        for shot in result.get('screenshots') or []:
            if isinstance(shot, dict) and shot.get('data'):
                add({'tab_id': shot.get('tabId'), 'url': shot.get('url'),
                     'title': shot.get('title')}, data=shot.get('data'))
    elif tool_name == 'browser_audit_page':
        if result.get('screenshot'):
            add({'filepath': result['screenshot']}, filepath=result['screenshot'])
    elif tool_name == 'browser_run_workflow':
        for step in result.get('steps') or []:
            if isinstance(step, dict) and step.get('failure_screenshot'):
                add({'step': step.get('label'), 'filepath': step['failure_screenshot']},
                    filepath=step['failure_screenshot'])
    return found


def build_tool_content(tool_name: str, arguments: dict, result) -> list:
    """Turn an HTTP tool result into MCP content blocks."""
    # browser_get_tabs documents include_favicon=false as the default, but
    # older extension builds send favIconUrl regardless, so enforce it here.
    favicons = 'scrub'
    if tool_name == 'browser_get_tabs':
        favicons = 'keep' if (arguments or {}).get('include_favicon') else 'drop'
    images = _collect_images(tool_name, result) if MCP_IMAGES else []

    blocks = []
    image_meta = []
    skipped = max(0, len(images) - MAX_IMAGES_PER_RESULT)
    images = images[:MAX_IMAGES_PER_RESULT]
    # Several images share the budget so one call can't return tens of MB.
    max_edge = IMAGE_MAX_EDGE if len(images) <= 1 else min(IMAGE_MAX_EDGE, 1024)
    max_b64 = IMAGE_MAX_B64 if len(images) <= 1 else max(200_000, IMAGE_MAX_B64 // len(images))

    for meta, raw, mime in images:
        try:
            img = prepare_image(raw, mime, max_edge, max_b64)
        except Exception as e:
            log(f"Image processing failed, returning original: {e}")
            img = {'data': base64.b64encode(raw).decode('ascii'), 'mimeType': mime,
                   'note': f'Could not process image ({e}); returned original.'}
        blocks.append({'type': 'image', 'data': img.pop('data'), 'mimeType': img['mimeType']})
        image_meta.append({k: v for k, v in {**meta, **img}.items() if v is not None})

    text_obj = _scrub(result, favicons=favicons)
    if isinstance(text_obj, dict) and image_meta:
        text_obj['images'] = image_meta
        if skipped:
            text_obj['images_not_returned'] = skipped

    return [{'type': 'text', 'text': json.dumps(text_obj, indent=2)}] + blocks


def handle_tools_call(msg):
    """Handle the tools/call request."""
    params = msg.get("params", {})
    tool_name = params.get("name")
    arguments = params.get("arguments", {}) or {}

    result = call_tool(tool_name, dict(arguments))

    return {
        "jsonrpc": "2.0",
        "id": msg.get("id"),
        "result": {
            "content": build_tool_content(tool_name, arguments, result)
        }
    }

def main():
    log("Starting MCP stdio wrapper")

    # Start HTTP server
    if not start_http_server():
        log("Failed to start HTTP server, exiting")
        sys.exit(1)

    log("Ready to handle requests")

    # Main message loop
    while True:
        msg = read_message()
        if msg is None:
            break

        method = msg.get("method", "")
        log(f"Received: {method}")

        response = None

        if method == "initialize":
            response = handle_initialize(msg)
        elif method == "notifications/initialized":
            # No response needed for notifications
            continue
        elif method == "tools/list":
            response = handle_tools_list(msg)
        elif method == "tools/call":
            response = handle_tools_call(msg)
        else:
            log(f"Unknown method: {method}")
            response = {
                "jsonrpc": "2.0",
                "id": msg.get("id"),
                "error": {
                    "code": -32601,
                    "message": f"Method not found: {method}"
                }
            }

        if response:
            write_message(response)

    log("Shutting down")

def cleanup(signum, frame):
    """Clean up on exit."""
    global server_process
    if server_process:
        server_process.terminate()
    sys.exit(0)

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    try:
        main()
    except KeyboardInterrupt:
        cleanup(None, None)
