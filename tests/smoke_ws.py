"""End-to-end smoke test of the bridge with Python: text and WXF requests, definitions, and the TeX
or picture that comes with a result.
    .venv/bin/python tests/smoke_ws.py [ws://127.0.0.1:18000/ws?token=testtoken]"""
import asyncio, sys
from urllib.parse import urlsplit
from websockets.asyncio.client import connect
from wolframclient.deserializers import binary_deserialize
from wolframclient.language import wl
from wolframclient.serializers import export

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:18000/ws?token=testtoken"
ORIGIN = "http://" + urlsplit(URL).netloc    # the page's origin, which the bridge accepts

INPUT_FORM = lambda text: lambda reply: reply.get("InputForm") == text

# (request, success expected, optional test of the reply); successful replies carry "TeX", or
# "Image" for graphics
CASES = [
    ("Integrate[x^2 Sin[x], x]", True),
    ("Solve[x^2 - 5 x + 6 == 0, x]", True),
    ("N[Pi, 50]", True),
    ("1/0", True),                                     # result with a message
    ("StringQ[RunProcess[\"hostname\", \"StandardOutput\"]]", True, INPUT_FORM("True")),   # any function
    ("wsbX = 5", True, INPUT_FORM("5")),               # definitions stay
    ("wsbX + 1", True, INPUT_FORM("6")),
    ("Clear[wsbX]; wsbX + 1", True, INPUT_FORM("1 + wsbX")),
    ("Integrate[", False),                             # syntax error
    (export(wl.Factor(wl.Plus(wl.Power(wl.Global.x, 4), -1)), target_format="wxf"), True),   # WXF request
    ("Sin[1, 2] + 1/0", True),                         # two messages
    ("Plot[Sin[x], {x, 0, 6}]", True),                 # SVG picture
    ("Image[RandomReal[1, {20, 20}]]", True),          # PNG picture
    (export(wl.Graphics(wl.Text("\\!\\(x\\)")), target_format="wxf"), True),   # box syntax in a label
    (b"8:f\x02s\x04Lists\x03Wsb", False, lambda reply: reply.get("Failure") == "Decode"),   # cut short
    ("Wsb + 1", True, INPUT_FORM("1 + Wsb")),
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
