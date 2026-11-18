# Launch thread for X

Attach a clip exported from the app to post 1 (a real race of your own agents works best; the demo race is clearly labelled as made up). Attach your results image to post 3, or reply to post 1 with a share link to the same race.

---

**1/**
I built Ghost Race: drop in two AI agent session logs and watch them race the same task.

Tool calls are pit stops. Failed calls are crashes. Tokens are fuel.

Free, open source, and it runs in your browser 🏁

https://abtx2323.github.io/ghost-race/

**2/**
One command races Claude Code and Codex on the same task, each in its own git worktree:

npx github:abtx2323/ghost-race race "fix the flaky test"

Live pit-stop feed in your terminal, then the race opens in your browser.

**3/**
Export a clip in wide, square or 9:16, or copy a link that replays the race for anyone.

Works with Claude Code, Codex, Gemini CLI, OpenAI Agents SDK and OpenTelemetry logs. Nothing leaves your machine.

**4/**
Races worth running:
• Claude Code vs Codex on the same bug
• Your agent with prompt v1 vs v2
• Same model, two different MCP setups

Post your races. I want to see who wins.

**5/**
Code: https://github.com/abtx2323/ghost-race

Plain JavaScript, no dependencies. PRs welcome for more log formats.
