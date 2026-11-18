# Log formats

Ghost Race reads these as they are:

- **Claude Code** session transcripts (`~/.claude/projects/<project>/<session>.jsonl`) and `claude -p --output-format stream-json --verbose` output
- **Codex CLI** rollouts (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) and `codex exec --json` output
- **Gemini CLI** saved chats (`~/.gemini/tmp/<project>/chats/session-*.json`) and `/chat save` checkpoints
- **OpenAI Agents SDK** span exports (see below)
- **OpenTelemetry** traces as OTLP JSON (see below)

For any other agent, write a small `.ghost.json` file. It's a list of timed events, so an adapter for your framework is usually a few lines of code.

## OpenAI Agents SDK

The SDK sends traces to the OpenAI dashboard by default. To also save them for Ghost Race, add a tracing processor that writes each span as a line of JSON:

```python
import json
from agents import add_trace_processor
from agents.tracing import TracingProcessor

class GhostRaceExporter(TracingProcessor):
    def __init__(self, path="agents-trace.jsonl"):
        self.file = open(path, "a")

    def _write(self, item):
        self.file.write(json.dumps(item.export(), default=str) + "\n")
        self.file.flush()

    def on_trace_start(self, trace): pass
    def on_trace_end(self, trace): self._write(trace)
    def on_span_start(self, span): pass
    def on_span_end(self, span): self._write(span)
    def shutdown(self): self.file.close()
    def force_flush(self): self.file.flush()

add_trace_processor(GhostRaceExporter())
```

Each trace in the file becomes a ghost, named after its workflow. Function calls are pit stops, failed calls and tripped guardrails are crashes, hand-offs show as SUB-AGENT, and generation usage is the fuel. (This matches the SDK's tracing API at the time of writing; check its docs if the import paths have moved.)

## OpenTelemetry

Export traces as OTLP JSON: one document with `resourceSpans`, or one document per line. Ghost Race reads:

- the OpenTelemetry GenAI conventions: `gen_ai.operation.name` (`chat`, `execute_tool`), `gen_ai.tool.name`, `gen_ai.usage.input_tokens` and `output_tokens`, `gen_ai.request.model`
- OpenInference (Arize Phoenix): `openinference.span.kind` (`LLM`, `TOOL`, `RETRIEVER`), `llm.token_count.*`, `llm.model_name`, `tool.name`
- OpenLLMetry (Traceloop): `traceloop.span.kind = tool`

Each trace becomes a ghost, up to six. Spans with an error status become crashes. Tool arguments and outputs are never read.

# The Ghost Race format

## One run

```json
{
  "ghostrace": 1,
  "name": "Planner v2",
  "model": "my-model-id",
  "task": "Fix the flaky checkout test",
  "events": [
    { "t": 0,    "type": "message", "tokens": 1200 },
    { "t": 2.5,  "type": "tool", "name": "search_docs", "tokens": 3400 },
    { "t": 7.1,  "type": "tool", "name": "run_tests", "command": "pytest -q", "tokens": 2100, "error": true },
    { "t": 12.0, "type": "tool", "name": "edit_file", "detail": "checkout.py", "tokens": 2600 },
    { "t": 15.3, "type": "message", "tokens": 900 },
    { "t": 15.3, "type": "finish" }
  ]
}
```

## Several runs in one file

```json
{ "ghostrace": 1, "runs": [ { "name": "A", "events": [] }, { "name": "B", "events": [] } ] }
```

A plain array of runs works too.

## Run fields

| Field | Required | Meaning |
| --- | --- | --- |
| `events` | yes | The timeline, in any order. Ghost Race sorts it by time. |
| `name` | no | Shown on the grid. Defaults to the model name. |
| `model` | no | Model id, for example `claude-sonnet-4-5`. |
| `task` | no | What the agent was asked to do. |
| `outcome` | no | `"dnf"` (or `"fail"`) if the agent reached the end without solving the task. The ghost still finishes the lap but is ranked last. |

## Event fields

| Field | Meaning |
| --- | --- |
| `t` | When it happened. A number is seconds since the start; a string is an ISO timestamp. |
| `type` | `tool` (a pit stop), `message` (the agent replied), `error` (a crash) or `finish`. |
| `name` | Tool name. Used to pick the pit-stop label, so `read_file` shows as READ and `run_tests` as TEST. |
| `command` | For shell tools, the command. `pytest`, `npm test` and friends show as TEST. |
| `detail` | Short text shown on the track when "Show file names and commands" is on. |
| `category` | Force a label: `read`, `search`, `edit`, `shell`, `test`, `web`, `agent`, `plan`, `mcp`, `ask` or `other`. |
| `tokens` | Tokens used by this step (input plus output). Ghost Race adds them up for the fuel bar and the Tokens race. |
| `cost` | Optional dollars for this step. |
| `error` | On a `tool` event, `true` marks that call as failed, which adds a crash right after it. |

## How a race is scored

Each ghost runs one lap, from its first move to its last.

- **Time** counts active seconds. Gaps longer than 30 seconds count as 30, so time spent waiting for a human doesn't decide the race. Turn off "Skip idle time" to count every second.
- **Tokens** counts total tokens. The cheapest run wins.
- **Steps** counts moves: tool calls and replies. The most direct run wins.

Steps are the moves that count toward the lap. Crashes don't move a ghost forward; they're marked where they happened.
