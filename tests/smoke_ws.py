"""End-to-end smoke test of the bridge with Python: text and WXF requests, refusals, limits."""
import asyncio, sys
from websockets.asyncio.client import connect
from wolframclient.deserializers import binary_deserialize
from wolframclient.language import wl
from wolframclient.serializers import export

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:18000/ws?token=testtoken"

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
]

async def main():
    failed = 0
    async with connect(URL, origin="http://127.0.0.1:18000") as ws:
        for request, ok in CASES:
            await ws.send(request)
            reply = binary_deserialize(await ws.recv())
            good = reply["Success"] == ok
            failed += not good
            shown = request if isinstance(request, str) else "WXF %d bytes" % len(request)
            detail = reply.get("InputForm") or "%s: %s %s" % (reply.get("Failure"), reply.get("Message"), reply.get("Symbols", ""))
            print("ok  " if good else "FAIL", shown, "->", detail[:100], reply.get("Messages") or "")
    print("all passed" if not failed else "%d failed" % failed)
    sys.exit(1 if failed else 0)

asyncio.run(main())
