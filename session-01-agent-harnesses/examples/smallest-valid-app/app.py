import json
import os
from datetime import UTC, datetime
from http.client import HTTPConnection, HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import urlsplit
from uuid import uuid4

history = [{"role": "system", "content": "Use the time tool for current time."}]
chat, error = [], ""
busy = Lock()
# The model receives this declaration; Python executes the function below.
tool_declaration = {
    "type": "function",
    "function": {
        "name": "get_current_time",
        "description": "Read the current UTC time.",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
}


def get_current_time():
    return datetime.now(UTC).isoformat()


def broker(path, body=None, profile=None):
    url = urlsplit(os.environ["WORKSHOP_BROKER_URL"])
    connection = HTTPConnection(url.hostname, url.port, timeout=90)
    headers = {
        "Authorization": "Bearer " + os.environ["WORKSHOP_RUN_TOKEN"],
        "Content-Type": "application/json",
        "X-Workshop-Contract-Version": "workshop.app.v1",
    }
    if body is not None:
        headers.update(
            {
                "X-Workshop-Operation-ID": str(uuid4()),
                "X-Workshop-Expected-Profile": profile,
                "X-Workshop-Attempt-Limit": "1",
            }
        )
    try:
        connection.request(
            "GET" if body is None else "POST",
            path,
            None if body is None else json.dumps(body),
            headers,
        )
        response = connection.getresponse()
        value = json.loads(response.read())
        if response.status != 200:
            raise ValueError(value["error"]["message"])
        return value
    finally:
        connection.close()


def run(prompt):
    global history, error
    try:
        boot = broker("/v1/bootstrap")
        if (
            boot["mode"] != "hosted"
            or boot["simulated"]
            or boot["runId"] != os.environ["WORKSHOP_RUN_ID"]
        ):
            raise ValueError("Start this app through the workshop portal.")
        selection = boot["inference"]["selection"]
        messages = history + [{"role": "user", "content": prompt}]
        # A turn contains one model response and its requested tool work.
        while True:
            model_request = {
                "model": selection["modelId"],
                "messages": messages,
                "tools": [tool_declaration],
                "max_tokens": 4096,
            }
            model_response = broker(
                "/v1/llm/chat/completions",
                model_request,
                selection["profileId"],
            )
            choice = model_response["choices"][0]
            assistant_message = {"role": "assistant", **choice["message"]}
            tool_calls = assistant_message.get("tool_calls", [])
            if (
                choice["finish_reason"] not in ("stop", "tool_calls")
                or (choice["finish_reason"] == "tool_calls") != bool(tool_calls)
                or assistant_message.pop("refusal", None)
            ):
                raise ValueError("The model did not complete its response.")
            if any(
                tool_call["function"]["name"] != "get_current_time"
                or json.loads(tool_call["function"]["arguments"]) != {}
                for tool_call in tool_calls
            ):
                raise ValueError("Invalid tool call.")
            messages.append(assistant_message)
            if assistant_message.get("content"):
                chat.append(["agent", assistant_message["content"]])
            if not tool_calls:
                if not assistant_message.get("content"):
                    raise ValueError("The model returned no answer.")
                # This run ends; its conversation remains for the next prompt.
                history = messages
                return
            for tool_call in tool_calls:
                observation = get_current_time()
                chat.append(["tool", observation])
                # The next request carries this observation and its matching call ID.
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call["id"],
                        "content": observation,
                    }
                )
    except (HTTPException, OSError, ValueError, KeyError, TypeError) as exception:
        error = str(exception).replace(
            os.environ.get("WORKSHOP_RUN_TOKEN", "\0"),
            "[redacted]",
        )
    finally:
        busy.release()


class Handler(BaseHTTPRequestHandler):
    def reply(self, body, content_type="application/json", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            return self.reply(b"ok", "text/plain")
        if self.path == "/state":
            return self.reply(
                json.dumps(
                    {
                        "chat": chat,
                        "busy": busy.locked(),
                        "error": error,
                    }
                ).encode()
            )
        files = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/chat.js": ("chat.js", "text/javascript"),
            "/montserrat.woff2": ("montserrat.woff2", "font/woff2"),
        }
        if self.path not in files:
            return self.send_error(404)
        name, content_type = files[self.path]
        self.reply(Path(__file__).with_name(name).read_bytes(), content_type)

    def do_POST(self):
        global error
        if self.path != "/chat":
            return self.send_error(404)
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 0 < size <= 24000:
                raise ValueError("Message too large.")
            text = json.loads(self.rfile.read(size))["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > 4000:
                raise ValueError("Enter 1–4,000 characters.")
        except (ValueError, KeyError, TypeError):
            return self.reply(b'{"error":"Enter 1-4,000 characters."}', status=400)
        if not busy.acquire(blocking=False):
            return self.reply(b'{"error":"Wait for the reply."}', status=409)
        error = ""
        chat.append(["you", text])
        Thread(target=run, args=(text,), daemon=True).start()
        self.reply(b'{"accepted":true}', status=202)


if __name__ == "__main__":
    ThreadingHTTPServer(
        ("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler
    ).serve_forever()
