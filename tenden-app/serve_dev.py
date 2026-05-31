import socket
import socketserver
import http.server
import os
import mimetypes
import urllib.request
import urllib.parse
import webbrowser
import sys

PORT = 8085

MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.geojson': 'application/geo+json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class SafeStaticHandler(http.server.BaseHTTPRequestHandler):
    """
    A fully custom static file handler for Windows.
    Reads files into memory before responding to avoid os.fstat()
    crashes (WinError 87) caused by node_modules junction points.
    """

    def log_message(self, fmt, *args):
        # Suppress default per-request stderr noise; keep it clean.
        pass

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        url_path = urllib.parse.unquote(parsed.path)

        # Default to index.html
        if url_path == '/':
            url_path = '/index.html'

        # Prevent directory traversal
        rel = url_path.lstrip('/')
        abs_path = os.path.normpath(os.path.join(BASE_DIR, rel))
        if not abs_path.startswith(BASE_DIR):
            self._send_error(403, "Forbidden")
            return

        if not os.path.isfile(abs_path):
            self._send_error(404, f"Not Found: {url_path}")
            return

        ext = os.path.splitext(abs_path)[1].lower()
        content_type = MIME_TYPES.get(ext, 'application/octet-stream')

        try:
            with open(abs_path, 'rb') as f:
                data = f.read()
        except OSError as e:
            self._send_error(500, f"Read error: {e}")
            return

        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        self.wfile.write(data)

    def _send_error(self, code, message):
        body = message.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP


def start_dev_server():
    local_ip = get_local_ip()
    dev_url = f"http://{local_ip}:{PORT}"
    localhost_url = f"http://localhost:{PORT}"

    print("======================================================================")
    print("  [+] TENDEN PREMIER DEVELOPER WORKSPACE SERVER")
    print("======================================================================")
    print(f"  * Local IP Identified : {local_ip}")
    print(f"  * Localhost URL       : {localhost_url}")
    print(f"  * Mobile Network URL  : {dev_url}")
    print("======================================================================")

    # 1. Generate QR Code image for mobile connection
    qr_filename = os.path.join(BASE_DIR, "assets", "dev_qr.png")
    qr_api_url = (
        f"https://api.qrserver.com/v1/create-qr-code/"
        f"?size=300x300&margin=15&data={dev_url}"
    )
    try:
        print("  Generating dynamic developer QR code...")
        urllib.request.urlretrieve(qr_api_url, qr_filename)
        print(f"  * QR Code saved to    : {qr_filename}")
        # 2. Auto-open app and QR code in browser
        print("  Opening Localhost App and Developer QR Code in browser...")
        webbrowser.open(localhost_url)
        webbrowser.open(qr_filename)
    except Exception as e:
        print(f"  [Warning] QR Code auto-generation skipped: {e}")

    print("\n  * SCAN THE QR CODE WITH YOUR PHONE CAMERA TO CONNECT!")
    print("  * PRESS CTRL+C TO STOP THE SERVER AT ANY TIME\n")
    print("  Starting HTTP Server...")

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), SafeStaticHandler) as httpd:
        print(f"  [OK] Serving on http://0.0.0.0:{PORT} (Ctrl+C to stop)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Development server stopped. Happy Coding!")
            sys.exit(0)


if __name__ == "__main__":
    start_dev_server()
