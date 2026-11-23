"""WebSocket bridge between browsers (WXF over binary WebSocket messages) and Wolfram kernels.

Each binary message is one WXF-encoded expression; a text message is taken as Wolfram Language
input. Every request gets exactly one binary reply: the WXF of an Association with "Success"
and either "Result"/"InputForm"/"Messages"/"Timing" (plus "TeX" or "Image" for showing the
result) or "Failure"/"Message". Replies on one
connection come in request order. The same port serves the files in web/ over plain HTTP.

Kernels run kernel/WSBridge.wl's Serve loop and talk to this process over a local ZMQ PAIR
socket each. A kernel that does not answer in time is killed with its whole process group
and replaced. A kernel that sends "restart" before a reply exits after it and is replaced too.
"""

import argparse
import asyncio
import contextlib
import hmac
import logging
import mimetypes
import os
import pathlib
import secrets
import signal
from http import HTTPStatus
from urllib.parse import parse_qs

import zmq
import zmq.asyncio
from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.http11 import Response

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
log = logging.getLogger("wsbridge")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")


# ---- minimal WXF writer for the server's own replies ----

def _varint(n):
    out = bytearray()
    while True:
        byte, n = n & 0x7F, n >> 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _wxf_value(v):
    if isinstance(v, bool):
        name = b"True" if v else b"False"
        return b"s" + _varint(len(name)) + name
    data = str(v).encode("utf-8")
    return b"S" + _varint(len(data)) + data


def wxf_string(text):
    return b"8:" + _wxf_value(text)


def wxf_failure(kind, message):
    entries = {"Success": False, "Failure": kind, "Message": message}
    body = b"".join(b"-" + _wxf_value(k) + _wxf_value(v) for k, v in entries.items())
    return b"8:A" + _varint(len(entries)) + body


# ---- kernels ----

class Kernel:
    """One kernel process running WSBridge`Serve, connected through a ZMQ PAIR socket."""

    count = 0

    def __init__(self, command, initfiles, run_dir):
        Kernel.count += 1
        self.name = "kernel-%d" % Kernel.count
        self.command, self.initfiles, self.run_dir = command, initfiles, run_dir
        self.proc = self.socket = None
        self.exiting = False

    async def start(self, timeout):
        self.socket = zmq.asyncio.Context.instance().socket(zmq.PAIR)
        self.socket.setsockopt(zmq.LINGER, 0)
        port = self.socket.bind_to_random_port("tcp://127.0.0.1")
        args = [self.command, "-noprompt"]
        for f in self.initfiles:
            args += ["-initfile", f]
        args += ["-run", 'WSBridge`Serve["tcp://127.0.0.1:%d"]' % port]
        output = open(self.run_dir / ("%s.log" % self.name), "wb")
        # own session and process group, so that kill() reaches udocker, proot and the kernel
        self.proc = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
        output.close()
        try:
            hello = await asyncio.wait_for(self.socket.recv(), timeout)
        except BaseException:
            self.kill()
            raise
        if hello != b"ready":
            self.kill()
            raise RuntimeError("%s sent %r instead of ready" % (self.name, hello[:40]))
        log.info("%s ready (pid %d)", self.name, self.proc.pid)
        return self

    async def evaluate(self, request, timeout):
        await self.socket.send(request)
        reply = await asyncio.wait_for(self.socket.recv(), timeout)
        if reply == b"restart":   # this kernel can no longer make pictures and exits after the reply
            self.exiting = True
            reply = await asyncio.wait_for(self.socket.recv(), timeout)
        return reply

    async def exited(self, timeout):
        """Waits for a kernel that exits by itself, so that its license is free again, then
        kills whatever is left of it."""
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self.proc.wait(), timeout)
        self.kill()

    def kill(self):
        if self.proc and self.proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.proc.pid, signal.SIGKILL)  # the kernel ignores SIGTERM
            log.info("%s killed", self.name)
        if self.socket:
            self.socket.close(linger=0)


class KernelPool:
    def __init__(self, size, command, initfiles, run_dir, start_timeout=120):
        self.size, self.command, self.initfiles, self.run_dir = size, command, initfiles, run_dir
        self.start_timeout = start_timeout
        self.idle = asyncio.Queue()
        self.kernels = set()

    async def _new(self):
        kernel = Kernel(self.command, self.initfiles, self.run_dir)
        self.kernels.add(kernel)
        try:
            await kernel.start(self.start_timeout)
        except BaseException:
            self.kernels.discard(kernel)
            raise
        return kernel

    async def start(self):
        for kernel in await asyncio.gather(*(self._new() for _ in range(self.size))):
            self.idle.put_nowait(kernel)

    async def _replace(self, kernel):
        if kernel.exiting:
            await kernel.exited(15)
        else:
            kernel.kill()
        self.kernels.discard(kernel)
        while True:
            try:
                self.idle.put_nowait(await self._new())
                return
            except Exception:
                log.exception("restarting a kernel failed; retrying in 10 s")
                await asyncio.sleep(10)

    async def evaluate(self, request, timeout):
        kernel = await self.idle.get()
        try:
            reply = await kernel.evaluate(request, timeout)
        except BaseException as exc:
            log.warning("%s did not answer (%s); replacing it", kernel.name, type(exc).__name__)
            asyncio.ensure_future(self._replace(kernel))
            if isinstance(exc, asyncio.CancelledError):
                raise
            return wxf_failure("KernelRestarted", "The kernel did not answer in time and was restarted.")
        if kernel.exiting:
            log.info("%s asked to be replaced", kernel.name)
            asyncio.ensure_future(self._replace(kernel))
        else:
            self.idle.put_nowait(kernel)
        return reply

    def close(self):
        for kernel in list(self.kernels):
            kernel.kill()
        self.kernels.clear()


# ---- WebSocket and HTTP ----

class Bridge:
    def __init__(self, pool, token, origins, request_timeout, max_reply):
        self.pool, self.token, self.origins, self.request_timeout = pool, token, origins, request_timeout
        self.max_reply = max_reply

    def process_request(self, connection, request):
        path, _, query = request.path.partition("?")
        if request.headers.get("Upgrade", "").lower() == "websocket":
            if path != "/ws":
                return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
            token = parse_qs(query).get("token", [""])[0]
            if not hmac.compare_digest(token.encode(), self.token.encode()):
                return connection.respond(HTTPStatus.FORBIDDEN, "Missing or wrong token\n")
            origin = request.headers.get("Origin")
            if origin is not None and origin not in self.origins:
                return connection.respond(HTTPStatus.FORBIDDEN, "Origin not allowed\n")
            return None
        return self.static(connection, path)

    def static(self, connection, path):
        name = "index.html" if path in ("", "/") else path.lstrip("/")
        file = (WEB / name).resolve()
        if WEB not in file.parents or not file.is_file():
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        body = file.read_bytes()
        headers = Headers([
            ("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream"),
            ("Content-Length", str(len(body))),
            ("Cache-Control", "no-cache"),
            ("X-Content-Type-Options", "nosniff"),
        ])
        return Response(200, "OK", headers, body)

    async def evaluate(self, request):
        if isinstance(request, str):
            request = wxf_string(request)
        if not request.startswith(b"8:"):
            return wxf_failure("Decode", "Only uncompressed WXF (header 8:) is accepted.")
        reply = await self.pool.evaluate(request, self.request_timeout)
        if len(reply) > self.max_reply:
            log.warning("reply of %d bytes not sent (--max-reply %d)", len(reply), self.max_reply)
            return wxf_failure("ReplyTooLarge", "The reply has %d bytes, more than the server's limit of %d."
                               % (len(reply), self.max_reply))
        return reply

    async def handler(self, ws):
        log.info("connection from %s", ws.remote_address)
        async for message in ws:
            await ws.send(await self.evaluate(message))


async def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--host", default="127.0.0.1", help="interface to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=18000)
    p.add_argument("--kernels", type=int, default=1, help="number of kernels (check your license's limit)")
    p.add_argument("--kernel", default=str(ROOT / "kernel" / "wolframkernel-udocker"),
                   help="kernel executable (default: the udocker wrapper)")
    p.add_argument("--time-limit", type=float, default=30, help="seconds per evaluation")
    p.add_argument("--memory-limit", type=int, default=2 * 1024**3, help="bytes per evaluation")
    p.add_argument("--format-time-limit", type=float, default=20,
                   help="seconds for the TeX or picture of a result, after the evaluation (default 20)")
    p.add_argument("--request-timeout", type=float,
                   help="seconds to wait for a kernel before replacing it (default: time limit + format time limit + 15)")
    p.add_argument("--max-message", type=int, default=8 * 1024**2, help="largest request in bytes")
    p.add_argument("--max-reply", type=int, default=64 * 1024**2,
                   help="largest reply in bytes; a larger one is replaced by a ReplyTooLarge failure")
    p.add_argument("--allow-origin", action="append", default=[], help="extra allowed page origin")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("websockets.server").setLevel(logging.WARNING)

    token = os.environ.get("WSBRIDGE_TOKEN") or secrets.token_urlsafe(24)
    origins = {f"http://{h}:{args.port}" for h in ("127.0.0.1", "localhost", args.host)} | set(args.allow_origin)

    run_dir = ROOT / "run"
    run_dir.mkdir(exist_ok=True)
    config = run_dir / "config.wl"
    config.write_text(
        f"WSBridge`$TimeLimit = {args.time_limit!r};\nWSBridge`$MemoryLimit = {args.memory_limit};\n"
        f"WSBridge`$FormatTimeLimit = {args.format_time_limit!r};\n")
    initfiles = [str(ROOT / "kernel" / "WSBridge.wl"), str(config)]

    pool = KernelPool(args.kernels, args.kernel, initfiles, run_dir)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    try:
        log.info("starting %d kernel(s) with %s", args.kernels, args.kernel)
        await pool.start()
        # a healthy kernel answers within its time limits for the evaluation and for the TeX or
        # picture of the result; the extra 15 s cover serialization
        bridge = Bridge(pool, token, origins,
                        args.request_timeout or args.time_limit + args.format_time_limit + 15, args.max_reply)
        async with serve(bridge.handler, args.host, args.port, process_request=bridge.process_request,
                         max_size=args.max_message):
            log.info("ready: open http://%s:%d/?token=%s  (WebSocket endpoint /ws?token=...)",
                     args.host, args.port, token)
            await stop
    finally:
        pool.close()
        log.info("stopped")


if __name__ == "__main__":
    asyncio.run(main())
