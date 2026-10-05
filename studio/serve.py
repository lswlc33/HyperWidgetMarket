#!/usr/bin/env python3
"""小部件设计工具 · 本地静态服务器（市场仓库根目录）

用法：
    python serve.py [端口] [--app <App 仓库路径>]

三件事：
  1. 一律 `Cache-Control: no-store`——改完 js/css 刷新就能看到，不会被浏览器缓存的
     旧文件骗（改 render.js 后页面还在跑旧代码，排查了半天）；
  2. `--app <路径>` 时把 App 仓库挂到 `/app/`，工具会**直读**它的
     res/ 与 assets/widget-ui.js（改令牌/图标/组件库 → 刷新即见）。不挂也没问题：
     工具会退回提交在本仓库的主题快照（studio/js/theme.generated.js）；
  3. 加 `Access-Control-Allow-Origin: *`：允许用别的端口/别的服务器托管工具时跨端口
     直读 App 仓库（只监听 127.0.0.1，不出机器）。
"""
import functools
import http.server
import os
import socketserver
import sys

# 服务器根必须是**市场仓库根**：工具里那些 "../" 相对链接（回市场首页）与 /studio/ 的
# 目录结构都要靠它才对得上；serve.py 自己住在 studio/ 下。
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

EXTRA_TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".kt": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    app_dir = None      # --app 指定的 App 仓库根

    def translate_path(self, path):
        # /app/... → App 仓库里的文件（工具直读 res/ 与 assets/ 用的就是这条）
        if self.app_dir and path.startswith("/app/"):
            rest = path[len("/app/"):].split("?", 1)[0].split("#", 1)[0]
            parts = [p for p in rest.split("/") if p and p not in (".", "..")]
            return os.path.join(self.app_dir, *parts)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 只报错误，正常请求不刷屏（工具会发很多小文件请求）
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    args = sys.argv[1:]
    app_dir = None
    if "--app" in args:
        i = args.index("--app")
        if i + 1 < len(args):
            app_dir = os.path.abspath(args[i + 1])
            del args[i:i + 2]
        else:
            print("[x] --app 后面要跟 App 仓库路径")
            return 1
    port = int(args[0]) if args else 8611

    if app_dir and not os.path.isdir(os.path.join(app_dir, "app", "src", "main", "res")):
        print("[!] %s 看起来不是 App 仓库（找不到 app/src/main/res），先按快照模式启动" % app_dir)
        app_dir = None

    Handler.app_dir = app_dir
    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True
    try:
        httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    except OSError as e:
        print("[x] 端口 %d 起不来：%s（换一个端口：python serve.py 8612）" % (port, e))
        return 1
    print("市场仓库根: %s" % ROOT)
    print("打开地址   : http://127.0.0.1:%d/studio/" % port)
    if app_dir:
        print("直读 App 仓: %s  →  /app/" % app_dir)
    else:
        print("直读 App 仓: 未挂载（用 studio/js/theme.generated.js 的主题快照）")
        print("            想改令牌/图标立刻生效：python serve.py %d --app <App 仓库路径>" % port)
    print("（Ctrl+C 停止；静态文件一律 no-store，改完刷新即见）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
