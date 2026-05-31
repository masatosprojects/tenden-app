import socket
import http.server
import socketserver
import os
import urllib.request
import webbrowser
import sys

PORT = 8080

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
    print("  🚀 TENDEN PREMIER DEVELOPER WORKSPACE SERVER")
    print("======================================================================")
    print(f"  * Local IP Identified : {local_ip}")
    print(f"  * Localhost URL      : {localhost_url}")
    print(f"  * Mobile Network URL  : {dev_url}")
    print("======================================================================")
    
    # 1. Generate and save a QR Code image pointing to the mobile network URL
    qr_filename = "assets/dev_qr.png"
    qr_api_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=15&data={dev_url}"
    try:
        print("  Generating dynamic developer QR code...")
        urllib.request.urlretrieve(qr_api_url, qr_filename)
        print(f"  * QR Code saved to    : {qr_filename}")
        
        # 2. Automatically open QR code and localhost in standard browser
        print("  Opening Localhost App and Developer QR Code in browser...")
        webbrowser.open(localhost_url)
        webbrowser.open(os.path.abspath(qr_filename))
    except Exception as e:
        print(f"  [Warning] QR Code auto-generation skipped: {e}")
    
    print("\n  👉 SCAN THE OPENED QR CODE WITH YOUR PHONE CAMERA TO CONNECT!")
    print("  👉 PRESS CTRL+C TO STOP SERVER AT ANY TIME\n")
    print("  Starting HTTP Server...")
    
    # Enable CORS and serve files
    class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
            super().end_headers()
            
    handler = MyHTTPRequestHandler
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Development server stopped. Happy Coding!")
            sys.exit(0)

if __name__ == "__main__":
    start_dev_server()
