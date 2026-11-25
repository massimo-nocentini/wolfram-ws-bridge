"""WebSocket bridge between browsers (WXF over binary WebSocket messages) and Wolfram kernels.

Each binary message is one WXF-encoded expression; a text message is taken as Wolfram Language
input. Every request gets exactly one binary reply: the WXF of an Association with "Success"
and either "Result"/"InputForm"/"Messages"/"Timing" (plus "TeX" or "Image" for showing the
result) or "Failure"/"Message". Replies on one
connection come in request order. The same port serves the files in web/ over plain HTTP.

Kernels run kernel/WSBridge.wl's Serve loop and talk to this process over a local ZMQ PAIR
socket each. Evaluations have no time limit: a kernel is killed, with its whole process group, and
replaced when the client that waits for it disconnects (reload the page to abort). A kernel that
exits (Quit[], a crash), or that sends "restart" before a reply, is replaced too.
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
import sys
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

class KernelExited(Exception):
    pass


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
        # a kernel without a valid license exits at once: report that instead of waiting
        received = asyncio.ensure_future(self.socket.recv())
        exited = asyncio.ensure_future(self.proc.wait())
        try:
            await asyncio.wait({received, exited}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        except BaseException:
            received.cancel(), exited.cancel(), self.kill()
            raise
        exited.cancel()
        if not received.done():
            received.cancel()
            self.kill()
            log_file = self.run_dir / ("%s.log" % self.name)
            tail = log_file.read_text(errors="replace").strip().splitlines()[-15:]
            what = ("exited with code %s" % self.proc.returncode if self.proc.returncode is not None
                    else "did not get ready in %g s" % timeout)
            raise RuntimeError("%s %s; the end of %s:\n%s" % (self.name, what, log_file, "\n".join(tail)))
        hello = received.result()
        if hello != b"ready":
            self.kill()
            raise RuntimeError("%s sent %r instead of ready" % (self.name, hello[:40]))
        log.info("%s ready (pid %d)", self.name, self.proc.pid)
        return self

    async def _recv(self):
        """The next message of the kernel; raises KernelExited if its process ends instead."""
        received = asyncio.ensure_future(self.socket.recv())
        exited = asyncio.ensure_future(self.proc.wait())
        try:
            await asyncio.wait({received, exited}, return_when=asyncio.FIRST_COMPLETED)
            if not received.done():   # a reply sent just before the exit may still be on its way
                await asyncio.wait({received}, timeout=1)
            if not received.done():
                raise KernelExited("exit code %s" % self.proc.returncode)
            return received.result()
        finally:
            received.cancel(), exited.cancel()

    async def evaluate(self, request):
        await self.socket.send(request)
        reply = await self._recv()
        if reply == b"restart":   # this kernel can no longer make pictures and exits after the reply
            self.exiting = True
            reply = await self._recv()
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
        self.closing = False

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
        while not self.closing:
            try:
                self.idle.put_nowait(await self._new())
                return
            except Exception:
                log.exception("restarting a kernel failed; retrying in 10 s")
                await asyncio.sleep(10)

    async def evaluate(self, request):
        kernel = await self.idle.get()
        try:
            reply = await kernel.evaluate(request)
        except BaseException as exc:
            what = "the client left" if isinstance(exc, asyncio.CancelledError) else "%s: %s" % (type(exc).__name__, exc)
            log.warning("%s did not answer (%s); replacing it", kernel.name, what)
            asyncio.ensure_future(self._replace(kernel))
            if not isinstance(exc, Exception):
                raise
            return wxf_failure("KernelRestarted", "The kernel exited and is being replaced; its definitions are lost.")
        if kernel.exiting:
            log.info("%s asked to be replaced", kernel.name)
            asyncio.ensure_future(self._replace(kernel))
        else:
            self.idle.put_nowait(kernel)
        return reply

    def close(self):
        self.closing = True
        for kernel in list(self.kernels):
            kernel.kill()
        self.kernels.clear()


# ---- WebSocket and HTTP ----

class Bridge:
    def __init__(self, pool, token, origins):
        self.pool, self.token, self.origins = pool, token, origins

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
        return await self.pool.evaluate(request)

    async def handler(self, ws):
        log.info("connection from %s", ws.remote_address)
        closed = asyncio.ensure_future(ws.wait_closed())
        async for message in ws:
            reply = asyncio.ensure_future(self.evaluate(message))
            try:
                await asyncio.wait({reply, closed}, return_when=asyncio.FIRST_COMPLETED)
                if not reply.done():   # the client left: nobody waits for this evaluation
                    return
            finally:
                reply.cancel()
            await ws.send(reply.result())


async def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--host", default="127.0.0.1", help="interface to listen on (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=18000)
    p.add_argument("--kernels", type=int, default=1, help="number of kernels (check your license's limit)")
    p.add_argument("--kernel", default=str(ROOT / "kernel" / "wolframkernel-udocker"),
                   help="kernel executable (default: the udocker wrapper)")
    p.add_argument("--allow-origin", action="append", default=[], help="extra allowed page origin")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    logging.getLogger("websockets.server").setLevel(logging.WARNING)

    token = os.environ.get("WSBRIDGE_TOKEN") or secrets.token_urlsafe(24)
    origins = {f"http://{h}:{args.port}" for h in ("127.0.0.1", "localhost", args.host)} | set(args.allow_origin)

    # one directory per port: servers started from the same checkout must not overwrite each
    # other's kernel logs
    run_dir = ROOT / "run" / ("port-%d" % args.port)
    run_dir.mkdir(parents=True, exist_ok=True)
    initfiles = [str(ROOT / "kernel" / "WSBridge.wl")]

    pool = KernelPool(args.kernels, args.kernel, initfiles, run_dir)
    stop = asyncio.get_running_loop().create_future()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
    try:
        log.info("starting %d kernel(s) with %s", args.kernels, args.kernel)
        await pool.start()
        bridge = Bridge(pool, token, origins)
        async with serve(bridge.handler, args.host, args.port, process_request=bridge.process_request,
                         max_size=None, ping_timeout=None):   # any message size, however long it takes to transfer
            shown = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host   # all interfaces (Docker)
            log.info("ready: open http://%s:%d/?token=%s  (WebSocket endpoint /ws?token=...)",
                     shown, args.port, token)
            await stop
            pool.closing = True
    finally:
        pool.close()
        log.info("stopped")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except RuntimeError as exc:   # a kernel did not start
        log.error("%s", exc)
        sys.exit(1)
