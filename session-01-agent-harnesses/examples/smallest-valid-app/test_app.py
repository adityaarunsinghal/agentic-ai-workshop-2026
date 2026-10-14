"""Exercise every declared model through a tool round without provider calls."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import app


class SelectedModelTests(unittest.TestCase):
    def test_selected_model_and_profile_survive_the_tool_round(self):
        manifest = json.loads(Path(__file__).with_name("workshop-app.json").read_text())
        profiles = {
            "deepseek/deepseek-v4.1-flash": "deepseek-auto",
            "openai/gpt-6-luna": "luna-auto",
            "z-ai/glm-5.3-flash": "glm-auto",
            "anthropic/claude-haiku-5.5": "haiku-auto",
        }
        self.assertEqual(set(manifest["inference"]["models"]), set(profiles))
        for model, profile in profiles.items():
            with self.subTest(model=model):
                calls = []
                app.history = [{"role": "system", "content": "Use the time tool."}]
                app.chat, app.error = [], ""

                def broker(path, body=None, selected_profile=None):
                    if path == "/v1/bootstrap":
                        return {
                            "mode": "development",
                            "simulated": False,
                            "contractVersion": "workshop.app.v1",
                            "inference": {"selection": {"modelId": model, "profileId": profile}},
                        }
                    self.assertEqual(path, "/v1/llm/chat/completions")
                    self.assertEqual(body["model"], model)
                    self.assertEqual(selected_profile, profile)
                    calls.append(body)
                    if len(calls) == 1:
                        return {"choices": [{"finish_reason": "tool_calls", "message": {
                            "content": None,
                            "tool_calls": [{"id": "time-call", "type": "function", "function": {
                                "name": "get_current_time", "arguments": "{}",
                            }}],
                        }}]}
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(body["messages"][-1], {
                        "role": "tool", "tool_call_id": "time-call",
                        "content": "2026-10-14T12:00:00+00:00",
                    })
                    return {"choices": [{"finish_reason": "stop", "message": {
                        "content": "The tool returned the current UTC time.",
                    }}]}

                with (
                    patch.dict("os.environ", {"WORKSHOP_DEVELOPMENT_URL": "https://example.com/api/development"}, clear=True),
                    patch.object(app, "broker", broker),
                    patch.object(app, "get_current_time", return_value="2026-10-14T12:00:00+00:00"),
                ):
                    app.busy.acquire()
                    app.run("What is the current UTC time?")
                self.assertEqual(app.error, "")
                self.assertFalse(app.busy.locked())
                self.assertEqual(len(calls), 2)
                self.assertEqual(app.history[-1]["content"], "The tool returned the current UTC time.")


if __name__ == "__main__":
    unittest.main()
