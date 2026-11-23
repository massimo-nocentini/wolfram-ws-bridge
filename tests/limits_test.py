"""Limits and recovery test. Needs a server started with short limits, for example:
    WSBRIDGE_TOKEN=testtoken .venv/bin/python server/bridge.py --time-limit 1 --memory-limit 200000000
Repeated time-limit aborts must never leave the kernel unable to answer."""
import asyncio, os, sys
from websockets.asyncio.client import connect
from wolframclient.deserializers import binary_deserialize

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:18000/ws?token=" + os.environ.get("WSBRIDGE_TOKEN", "testtoken")
CASES = [("FixedPoint[# + 1 &, 0]", "TimeLimit"), ("Total[Range[10^9]^2]", "MemoryLimit"),
         ("Length[Table[i, {i, 10^9}]]", "MemoryLimit")]

async def main():
    failed = 0
    async with connect(URL) as ws:
        async def ask(q):
            await ws.send(q)
            return binary_deserialize(await asyncio.wait_for(ws.recv(), 60))
        for n in range(10):
            for q, failure in CASES:
                r = await ask(q)
                if r.get("Failure") != failure:
                    failed += 1
                    print("FAIL", q, "->", r)
            r = await ask(f"{n} + 1")
            if r.get("InputForm") != str(n + 1):
                failed += 1
                print("FAIL kernel stopped answering after limits:", r)
    print("limits: all passed" if not failed else f"limits: {failed} failed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
