# Ghost Race

**Race your AI agents.** Give two agents the same task and watch them race it as ghosts on a track. Tool calls are pit stops, failed calls are crashes, and tokens are fuel. Export the race as an MP4, or send a link that replays it in anyone's browser.

![A Ghost Race replay: three ghosts race a lap, The Planner overtakes Speed Demon late and wins](docs/demo.gif)

*The demo race uses three made-up ghosts. Load your own logs to race real agents.*

**Try it:** [abtx2323.github.io/ghost-race](https://abtx2323.github.io/ghost-race/), or download this repo and open `index.html`. There's nothing to install and no build step.

## Race two agents with one command

```bash
cd your-project
npx github:abtx2323/ghost-race race "fix the flaky checkout test"
```

This runs Claude Code and Codex on the same task at the same time, each in its own git worktree, so neither can touch the other's files or your working copy. You get a live feed of every pit stop in the terminal, a results table, a summary of what each agent changed, and the race opens in your browser. The output looks like this (the numbers here are illustrative):

```
Lights out
   0:04  claude  READ      checkout.test.ts
   0:06  codex   SEARCH    rg -n setTimeout src
   0:19  claude  TEST      npm test -- checkout
   0:31  claude  CRASH
   ...
Results  (ranked by agent time)
  1  SON  Sonnet 4.5   4:58    13 tool calls    0 errors   334k tokens  $0.41
  2  COD  Codex        +26.0s  15 tool calls    3 errors   400k tokens
```

Options: `--agents claude,codex` (or `claude,claude` to race an agent against itself), `--timeout 30`, `--claude-args "--model opus"`, `--codex-args "..."`, `--title`, `--mode time|tokens|steps`, `--cleanup` to remove the worktrees afterwards, `--yes` to skip the confirmation. Run `npx github:abtx2323/ghost-race --help` for the full list.

Before it starts, the command prints exactly how each agent will run and asks you to confirm. Claude Code runs with `--permission-mode acceptEdits --allowedTools Bash`, so it can edit files and run commands in its worktree without sandboxing; Codex runs with `--full-auto` in its workspace sandbox. Only race agents on code you're comfortable letting them change.

Already have logs? `npx github:abtx2323/ghost-race open session-a.jsonl session-b.jsonl` opens them as a race.

## Race logs you already have

1. Find the session logs:
   - **Claude Code:** `~/.claude/projects/<your-project>/<session-id>.jsonl`. List the newest with `ls -t ~/.claude/projects/*/*.jsonl | head`.
   - **Codex CLI:** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, or the output of `codex exec --json`.
   - **Gemini CLI:** saved chats in `~/.gemini/tmp/<project>/chats/`.
   - **OpenAI Agents SDK, OpenTelemetry or anything else:** see the [format guide](docs/FORMAT.md).
2. Drop the files onto the page. You can race up to six ghosts.
3. Pick how to race (time, tokens or steps), add a title, then **Export clip** or **Copy share link**.

No logs handy? Drop the sample files from [`examples/`](examples) to see each format race.

Hidden folders tripping you up? On a Mac, press <kbd>Cmd</kbd> <kbd>Shift</kbd> <kbd>G</kbd> in the file picker and paste the path.

## What you see

| On the track | What it means |
| --- | --- |
| Ghost | One agent run. Each ghost runs one lap, from its first move to its last. |
| Pit stop label (READ, EDIT, TEST...) | The agent called a tool. Shell commands that run tests show as TEST. |
| CRASH and sparks | A tool call failed: a non-zero exit code, a failing test, an API error. |
| Dots on the racing line | Every pit stop so far, so you can see where each agent spent its moves. |
| Fuel bar | Tokens burned. |
| Timing tower | Live positions and the gap to the leader, worked out the way F1 does it: how much earlier the leader passed the same point. |
| Sectors | The lap is split into thirds. Purple marks the fastest time in each sector. |
| Race control | Story beats: where the runs first chose different tools, crashes, lead changes, the finish. |

## Three ways to race

- **Time**: active agent time. Gaps over 30 seconds (waiting for you to approve something) count as 30 seconds. You can turn that off.
- **Tokens**: total tokens. The cheapest run wins.
- **Steps**: tool calls plus replies. The most direct run wins.

## Sharing

**Export clip** makes a 22-second MP4 with the start lights, the race and the results card, in three shapes: wide 16:9 (1920×1080), square (1080×1080) or tall 9:16 (1080×1920) for phone feeds. Chrome, Edge and Safari encode it in a few seconds. Browsers without H.264 encoding record it in real time instead; Firefox saves WebM, which you'd need to convert for X.

**Copy share link** makes a link that replays the race in anyone's browser. The race is compressed into the part of the link after `#`, which browsers never send to a server, and it holds only ghost names, timings, tool types and token counts.

**Save results image** saves a PNG of the results card.

## Privacy

Session logs can contain your code, file paths, prompts and sometimes secrets, so Ghost Race is built to keep them on your device:

- **No network access.** There's no server, and the page's Content Security Policy blocks every outgoing request. Parsing, rendering and video encoding all happen in your browser.
- **Details off by default.** File names and commands only appear on the track if you turn on "Show file names and commands". The race title is whatever you type.
- **Secrets scrubbed.** When details are on, API keys, tokens, passwords, credentials in URLs, private keys and home-folder usernames are replaced with `[redacted]`. It's pattern-based, so watch your clip before posting if you turned details on.
- **Share links carry no content.** Names, timings, tool types and token counts only.

See [SECURITY.md](SECURITY.md) to report a problem.

## Supported logs

| Source | Status |
| --- | --- |
| Claude Code session `.jsonl` and `claude -p --output-format stream-json` | Supported |
| Codex CLI rollout `.jsonl` and `codex exec --json` | Supported |
| Gemini CLI saved chats and `/chat save` checkpoints | Beta |
| OpenAI Agents SDK span exports | Beta ([how to export](docs/FORMAT.md#openai-agents-sdk)) |
| OpenTelemetry OTLP JSON: GenAI conventions, OpenInference, OpenLLMetry | Beta. Each trace becomes a ghost. |
| Ghost Race `.ghost.json` | Supported. Use it for any other agent. |

"Beta" formats were built from each tool's documented format and tested with sample files, not yet with a wide range of real logs. If one looks wrong, open an issue with a redacted sample.

## Development

```
npm test                       # parser, race, share-link and CLI tests (Node 20+)
node tools/build-single.mjs    # bundle everything into dist/ghost-race.html
```

Plain JavaScript, no dependencies, no build needed to run.

| File | What it does |
| --- | --- |
| `src/parsers.js` | Turns each log format into a run: steps, pit stops, crashes, tokens |
| `src/race.js` | Race maths: progress on the lap, standings, gaps, sectors, race-control moments |
| `src/render.js` | Draws a frame on a canvas. It's a pure function of the race and playback time, so scrubbing and exports match. |
| `src/export.js`, `src/mp4.js` | Fast export with WebCodecs and a small MP4 writer; real-time MediaRecorder fallback; PNG export |
| `src/share.js` | Share links |
| `src/app.js` | Page wiring |
| `bin/ghost-race.mjs` | The `race` and `open` commands |

To add a log format, write a parser in `src/parsers.js` that returns events shaped like `{ t, kind: 'tool' | 'talk' | 'crash', name, cat, detail, tokens }`, add a detector in `GR.parseLog`, and add a sample to `examples/` with a test.

## License

MIT. Fonts: [Anton](https://fonts.google.com/specimen/Anton) and [Fira Sans](https://fonts.google.com/specimen/Fira+Sans) under the SIL Open Font License (see `fonts/`).
