# The bridge server with its own Wolfram Engine, built on Wolfram's official image.
#
#   docker build -t wolfram-ws-bridge .
#   docker run --rm -p 127.0.0.1:18000:18000 -e WSBRIDGE_TOKEN=... \
#     -v ~/.WolframEngine/Licensing:/home/wolframengine/.WolframEngine/Licensing wolfram-ws-bridge
#
# The image has no license: mount an activated Licensing folder (see README, "Docker").
# Arguments after the image name go to server/bridge.py, e.g. --kernels 2 --time-limit 10.

ARG WOLFRAM_ENGINE_IMAGE=wolframresearch/wolframengine:15.0
FROM ${WOLFRAM_ENGINE_IMAGE}

USER root
# tini as PID 1 reaps the processes that a killed kernel leaves behind (its front end)
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/wolfram-ws-bridge
COPY requirements.txt .
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

COPY server/ server/
COPY kernel/WSBridge.wl kernel/allowlist.txt kernel/
COPY web/ web/
# run/ holds the kernel configuration and logs
RUN mkdir run && chown wolframengine:wolframengine run \
 && /opt/venv/bin/python server/bridge.py --help > /dev/null

USER wolframengine
ENV PYTHONUNBUFFERED=1
EXPOSE 18000
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/venv/bin/python", "server/bridge.py", \
            "--host", "0.0.0.0", "--kernel", "/usr/local/bin/WolframKernel"]
