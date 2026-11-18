# Launch thread for X

Attach a clip exported from the app to post 1 (a real race of your own agents works best; the demo race is clearly labelled as made up). Attach `docs/results.png` or your own results image to post 2.

---

**1/**
I built Ghost Race: drop in two AI agent session logs and watch them race the same task.

Tool calls are pit stops. Failed calls are crashes. Tokens are fuel.

Free, open source, and it runs in your browser 🏁

https://abtx2323.github.io/ghost-race/

**2/**
Each agent runs one lap, from its first move to its last. Race by agent time, tokens burned or number of moves.

Live timing tower, sector times, and race control calling out crashes, lead changes and the move where the agents first split.

**3/**
Works with Claude Code and Codex CLI logs out of the box. Anything else can use a tiny JSON format.

Your logs never leave your machine. Parsing, rendering and the MP4 export all happen in the browser.

**4/**
Races worth running:
• Claude Code vs Codex on the same bug
• Your agent with prompt v1 vs v2
• Same model, two different MCP setups

Post your races. I want to see who wins.

**5/**
Code: https://github.com/abtx2323/ghost-race

Plain JavaScript, no install. PRs welcome for more log formats: OpenAI Agents SDK, LangGraph, OpenTelemetry, Gemini CLI.
