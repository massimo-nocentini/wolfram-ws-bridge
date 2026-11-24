"""Limits and recovery test. Needs a server started with short limits, for example:
    WSBRIDGE_TOKEN=testtoken .venv/bin/python server/bridge.py --time-limit 1 --memory-limit 200000000 --format-time-limit 2
Repeated time-limit aborts must never leave the kernel unable to answer, and a picture whose
export runs out of time must not leave the front end unable to make the next one."""
import asyncio, os, sys
from websockets.asyncio.client import connect
from wolframclient.deserializers import binary_deserialize

URL = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:18000/ws?token=" + os.environ.get("WSBRIDGE_TOKEN", "testtoken")
# the memory cases must pass the limit long before the 1 s time limit, also on a loaded machine:
# the Join doubles a list of 8 MB until it passes 200 MB (about 0.07 s; Total[Range[10^9]^2] took
# 0.9-1 s and was sometimes stopped by the time limit first), and Table asks for 8 GB at once
CASES = [("FixedPoint[# + 1 &, 0]", "TimeLimit"), ("Total[Nest[Join[#, #] &, Range[10^6], 10]]", "MemoryLimit"),
         ("Length[Table[i, {i, 10^9}]]", "MemoryLimit")]
SLOW_EXPORT = "Graphics[Table[Disk[{i, j}, 0.4], {i, 300}, {j, 300}]]"   # about 6 s for the front end
PLOT = "Plot[Sin[x], {x, 0, 6}]"

async def main():
    failed = 0
    async with connect(URL, max_size=None) as ws:
        async def ask(q):
            await ws.send(q)
            # long enough for a kernel restart, also when the new kernel does not start: the bridge
            # gives up on it after 120 s and starts another one 10 s later
            return binary_deserialize(await asyncio.wait_for(ws.recv(), 300))
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
        for n in range(2):
            r = await ask(SLOW_EXPORT)
            if not r.get("Success") or "Image" in r or r.get("Format") not in ("TimeLimit", "MemoryLimit"):
                failed += 1
                print("FAIL slow export ->", {k: v for k, v in r.items() if k != "Result"})
            # A broken export machinery answers at once without a picture (and without "Format"). On a
            # loaded machine the first picture of a new kernel can take more than the 2 s format
            # limit instead: that "Format" -> "TimeLimit" restarts the kernel again, and the Plot is
            # asked again, at most three times
            for attempt in range(3):
                r = await ask(PLOT)
                if r.get("Format") != "TimeLimit" or "Image" in r:
                    break
                print("slow picture after a restart, attempt", attempt + 1)
            if r.get("Image", {}).get("Format") != "SVG":
                failed += 1
                print("FAIL no picture after a slow export:", {k: v for k, v in r.items() if k != "Result"})
    print("limits: all passed" if not failed else f"limits: {failed} failed")
    sys.exit(1 if failed else 0)

asyncio.run(main())
