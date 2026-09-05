"""A stand-in for MCDC, for integration tests. **Not a real MCDC service.**

There is no MCDC endpoint in this repository and none is assumed here. What
this is: a small server that speaks the contract *we propose*, so that our half
of the integration can be exercised over a real socket — a real request, real
headers, a real JSON body, real timeouts — instead of a patched function.

What it proves is what the Form Builder **sends**, and how it behaves when the
far end answers well or badly. It proves nothing whatever about MCDC, which
has not published a contract yet. When the real one arrives, the payload and
the responses here are what change; see EXPORT_API.md.

    POST /forms                      the endpoint MCDCConnector posts to
    POST /__control__/reply          what to answer next
    GET  /__control__/received       every request it has been sent
    POST /__control__/reset          forget all of it

The control endpoints exist only so a test can steer it. Nothing outside
`tests/` imports this module, and it is never started by the application.
"""
import time
from typing import Any, Dict, List

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# What it has been sent, and what it should say next. In memory: the server
# lives for the length of a test session and remembers nothing after it.
RECEIVED: List[Dict[str, Any]] = []
REPLY: Dict[str, Any] = {"status": 200, "body": {"id": "MCDC-1"}, "delay": 0.0}

app = FastAPI(title="Mock MCDC (tests only)")


@app.post("/forms")
async def receive_form(request: Request):
    """Take a published form configuration, and answer however a test said to.

    Everything about the request is kept — headers included — so a test can ask
    what was actually sent rather than what we believe was sent.
    """
    try:
        body = await request.json()
    except Exception:
        body = None

    RECEIVED.append({
        "path": "/forms",
        "method": request.method,
        "headers": dict(request.headers),
        "body": body,
        "query": dict(request.query_params),
    })

    # A slow answer is how a timeout is tested: the connector gives up on its
    # own clock, and this is still holding the socket open when it does.
    if REPLY.get("delay"):
        time.sleep(float(REPLY["delay"]))

    status = int(REPLY.get("status", 200))
    body = REPLY.get("body")
    if body is None:
        return JSONResponse(status_code=status, content=None)
    return JSONResponse(status_code=status, content=body)


# --------------------------------------------------------------------------- #
# steering it
# --------------------------------------------------------------------------- #
@app.post("/__control__/reply")
async def set_reply(request: Request):
    """`{"status": 500}`, `{"status": 200, "body": {...}}`, `{"delay": 3}`."""
    wanted = await request.json()
    REPLY.update({"status": wanted.get("status", 200),
                  "body": wanted.get("body", {"id": "MCDC-1"}),
                  "delay": wanted.get("delay", 0.0)})
    return {"ok": True}


@app.get("/__control__/received")
async def received():
    return {"count": len(RECEIVED), "requests": RECEIVED}


@app.post("/__control__/reset")
async def reset():
    RECEIVED.clear()
    REPLY.update({"status": 200, "body": {"id": "MCDC-1"}, "delay": 0.0})
    return {"ok": True}
