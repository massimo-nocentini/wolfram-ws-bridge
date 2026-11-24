"""End-to-end smoke test of the bridge with Python: text and WXF requests, refusals, limits, the
TeX or picture that comes with a result, and symbols that refused requests must not leave behind.
    .venv/bin/python tests/smoke_ws.py [ws://127.0.0.1:18000/ws?token=testtoken]"""
import asyncio, sys
from urllib.parse import urlsplit
from websockets.asyncio.client import connect
from wolframclient.deserializers import binary_deserialize
from wolframclient.language import wl
from wolframclient.serializers import export

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:18000/ws?token=testtoken"
ORIGIN = "http://" + urlsplit(URL).netloc    # the page's origin, which the bridge accepts

NOT_ALLOWED = lambda reply: reply.get("Failure") == "NotAllowed"
RUN_REFUSED = lambda reply: NOT_ALLOWED(reply) and "System`Run" in reply.get("Symbols", ())
REFUSED = lambda *names: lambda reply: NOT_ALLOWED(reply) and sorted(reply.get("Symbols", ())) == sorted(names)
INPUT_FORM = lambda text: lambda reply: reply.get("InputForm") == text

# (request, success expected, optional test of the reply); successful replies carry "TeX", or
# "Image" for graphics
CASES = [
    ("Integrate[x^2 Sin[x], x]", True),
    ("Solve[x^2 - 5 x + 6 == 0, x]", True),
    ("N[Pi, 50]", True),
    ("1/0", True),                                     # result with a message
    ('Run["id"]', False),                              # refused symbol
    ('Import["/etc/passwd"]', False),
    ("x = 5", False),
    ('ToExpression["Run[\\"id\\"]"]', False),
    ("Integrate[", False),                             # syntax error
    (export(wl.Factor(wl.Plus(wl.Power(wl.Global.x, 4), -1)), target_format="wxf"), True),   # WXF request
    ("Sin[1, 2] + 1/0", True),                         # two messages
    (export(wl.Get("/etc/passwd"), target_format="wxf"), False),
    ("Plot[Sin[x], {x, 0, 6}]", True),                 # SVG picture
    ("Image[RandomReal[1, {20, 20}]]", True),          # PNG picture
    # symbols in association keys, which Cases does not see in a decoded WXF association
    (export({wl.Run("id"): 1}, target_format="wxf"), False, RUN_REFUSED),
    (export(wl.Normal({wl.Run("id"): 1}), target_format="wxf"), False, RUN_REFUSED),
    # box syntax in strings, which the front end would read when it draws a label
    (export(wl.Graphics(wl.Text("\\!\\(x\\)")), target_format="wxf"), False, NOT_ALLOWED),
    ('Graphics[Text["\\.5c!\\.5c(x\\.5c)"]]', False, NOT_ALLOWED),
    # a WXF symbol without a context is a System` symbol, which reading the request creates: it
    # is refused and removed again, so that the name still means the variable in later requests
    (export(wl.Plus(wl.WsbQzz, 1), target_format="wxf"), False, REFUSED("System`WsbQzz")),
    ("WsbQzz + 1", True, INPUT_FORM("1 + WsbQzz")),
    (export(wl.Plus(wl.Global.WsbQzz, 2), target_format="wxf"), True, INPUT_FORM("2 + WsbQzz")),
    (export(wl.WsbQzz, target_format="wxf"), False, REFUSED("System`WsbQzz")),   # not Decode
    (export(wl.Global.WsbQzz, target_format="wxf"), True, INPUT_FORM("WsbQzz")),
    # the same name sent first with a context, then without
    (export(wl.Plus(wl.Global.WsbB, 1), target_format="wxf"), True, INPUT_FORM("1 + WsbB")),
    (export(wl.WsbB, target_format="wxf"), False, REFUSED("System`WsbB")),
    ("WsbB + 1", True, INPUT_FORM("1 + WsbB")),
    # typed System`name, and names that typed input cannot form, refused without a trace
    ("System`WsbNew + 1", False, REFUSED("System`WsbNew")),
    ("WsbNew + 1", True, INPUT_FORM("1 + WsbNew")),
    ('{Run["id"], Wsb`Ctx`v, wsbLeft}', False, REFUSED("System`Run", "Wsb`Ctx`v")),
    (b"8:f\x02s\x04Lists\x01*s\x03a b", False, REFUSED("System`*", "System`a b")),
    (b"8:f\x02s\x04Lists\x03Wsb", False, lambda reply: reply.get("Failure") == "Decode"),   # cut short
    ("Wsb + 1", True, INPUT_FORM("1 + Wsb")),
    # the System` symbol with the empty name (WXF "System`") is removed too: the second request
    # creates it again
    (b"8:s\x07System`", False, lambda reply: REFUSED("System`")(reply) and "does not exist" in reply["Message"]),
    (b"8:s\x07System`", False, lambda reply: REFUSED("System`")(reply) and "does not exist" in reply["Message"]),
    # reading stops after 10000 new symbols: refused, and the symbols read so far are removed
    (export([getattr(wl, "WsbCap%d" % i) for i in range(10002)], target_format="wxf"), False,
     lambda reply: NOT_ALLOWED(reply) and "more than 10000" in reply["Message"]),
    ("WsbCap5 + WsbCap10000 + 1", True, INPUT_FORM("1 + WsbCap10000 + WsbCap5")),
    ("Length[{%s}]" % ", ".join("wsbT%d" % i for i in range(10001)), False,
     lambda reply: NOT_ALLOWED(reply) and "more than 10000" in reply["Message"]),
    ("Length[{%s}]" % ", ".join("wsbT%d" % i for i in range(10000)), True, INPUT_FORM("10000")),
]


def shown(reply):
    """True if a successful reply comes with something to show: TeX, an SVG or a PNG."""
    image = reply.get("Image")
    if image is None:
        return isinstance(reply.get("TeX"), str) and reply["TeX"] != ""
    data = image.get("Data")
    if image.get("Format") == "SVG":
        return isinstance(data, str) and "<svg" in data[:300]
    return image.get("Format") == "PNG" and bytes(data[:8]) == b"\x89PNG\r\n\x1a\n"

async def main():
    failed = 0
    async with connect(URL, origin=ORIGIN, max_size=None) as ws:
        for request, ok, *test in CASES:
            await ws.send(request)
            reply = binary_deserialize(await ws.recv())
            good = reply["Success"] == ok and (not ok or shown(reply)) and all(t(reply) for t in test)
            failed += not good
            label = request[:80] if isinstance(request, str) else "WXF %d bytes" % len(request)
            detail = reply.get("InputForm") or "%s: %s %s" % (reply.get("Failure"), reply.get("Message"), reply.get("Symbols", ""))
            extra = ("[%s]" % reply["Image"]["Format"]) if "Image" in reply else ("[TeX]" if "TeX" in reply else "")
            print("ok  " if good else "FAIL", label, "->", detail[:100], extra, reply.get("Messages") or "")
    print("all passed" if not failed else "%d failed" % failed)
    sys.exit(1 if failed else 0)

asyncio.run(main())
