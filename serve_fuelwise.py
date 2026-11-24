"""Локальный сервер FuelWise V5 для запуска из Windows."""
import errno
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = "127.0.0.1"
PORT = 8876
ROOT = Path(__file__).resolve().parent


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False
    allow_reuse_port = False

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def main():
    if not (ROOT / "index.html").is_file():
        sys.exit(f"В папке {ROOT} отсутствует index.html.")

    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    try:
        server = LocalServer((HOST, PORT), handler)
    except OSError as error:
        if error.errno == errno.EADDRINUSE or error.winerror == 10048:
            sys.exit(f"Порт {PORT} уже занят. Если FuelWise V5 уже запущен, используйте его открытое окно.")
        if error.winerror == 10013:
            sys.exit(f"Порт {PORT} занят другим приложением или доступ к нему ограничен. Проверьте, открыт ли уже сервер V5.")
        sys.exit(f"Не удалось запустить сервер FuelWise V5: {error}")

    with server:
        print(f"FuelWise V5 готов. Откройте в Chrome http://{HOST}:{PORT}/")
        print("Оставьте это окно открытым. Для остановки нажмите Ctrl+C.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("Сервер FuelWise V5 остановлен.")


if __name__ == "__main__":
    main()
