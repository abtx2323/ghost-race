# Security

Ghost Race runs entirely in the browser. It has no server, no dependencies and no network access: the page's Content Security Policy blocks every outgoing request, so session logs can't leave your device.

What it does to protect what's in your logs:

- File names and commands are hidden on the track unless you turn on "Show file names and commands".
- Even when they're shown, API keys, tokens, passwords, credentials in URLs, private keys and home-folder usernames are replaced with `[redacted]` before anything is drawn. Redaction is pattern-based, so it can miss unusual secrets. Watch a clip before you post it if you turned details on.
- Log files are treated as untrusted input: text is drawn on a canvas or set as plain text, never as HTML, and files over 300 MB or 200,000 events are refused.

## Reporting a vulnerability

Please report security problems privately with GitHub's "Report a vulnerability" button on the Security tab of this repository, not in a public issue. Include the steps or a sample file that shows the problem.
