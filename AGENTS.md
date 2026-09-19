# 🛡️ Antigravity Bridge - Agent Development & Deployment Guidelines

## 🔖 Edition status (read this first)

- **v1.0.0 (2026-09-19) is the last release that ships both editions.**
- **Node.js edition** (`src/`, `tests/`, `package.json`, port `8008`) is the **only edition under development**. Every new feature, fix, and README change goes here.
- **Python edition** (`antigravity_bridge.py`, `test_antigravity_bridge.py`, `safe_deploy.sh`, port `8000`) is **frozen at v1.0.0**. Do not add features to it. Do not port Node.js changes to it. Touch it only for a security fix that the owner explicitly asks for, and then follow the staging workflow at the end of this file.
- README rows that describe both editions stay as they are for v1.0.0; new rows describe the Node.js edition only.

---

## ⚠️ CRITICAL ARCHITECTURAL WARNING: "The Self-Hosting Danger"

`antigravity-bridge` serves as the primary live API gateway and communication channel for AI assistants (Antigravity, Hermes Agent, Cursor, Claude Code, etc.) interacting with Google Antigravity (Gemini) and Anthropic Claude.

**When an AI agent is working on this codebase, the agent ITSELF may be communicating through this bridge.**

If an agent edits the running edition in place and introduces a syntax error, an unhandled exception, or a broken import:
1. The bridge server crashes or rejects requests.
2. The agent's own connection to the LLM API is instantly severed.
3. The session freezes, the user is locked out with `Antigravity Bridge Error: All agy profile execution attempts failed`, and the agent cannot even receive commands to repair its mistake.

So: never restart a bridge before the change is verified, and never leave a bridge running on unverified code.

---

## ✅ Node.js edition workflow (the normal case)

1. **Edit** under `src/` (and `tests/`). Keep the module layout: `src/server.mjs` (HTTP), `src/core/executor.mjs` (agy runs, profile fallback, API-mode tool guard), `src/translators/*.mjs` (OpenAI/Anthropic ⇄ agy prompt, tool-call parsing), `src/config.mjs` (env switches).
2. **Verify** before anything touches a running server:
   ```bash
   node --check src/server.mjs src/core/executor.mjs src/translators/tools.mjs src/config.mjs
   npm test
   ```
   Add a test in `tests/*.test.mjs` for every behaviour change; the executor tests drive a fake `agy` written as a small Node script, see `tests/security.test.mjs` for the pattern.
3. **Commit and push** to `main`. Name the behaviour, not the file, in the subject; put the evidence (what was seen in logs, what the test proves) in the body.
4. **Deploy** (production is a plain `git clone` running under systemd; see the owner's notes):
   ```bash
   git pull --ff-only
   npm test
   # restart the Node service only after tests pass; then poll /health
   curl -s http://127.0.0.1:8008/health
   ```
   Restart only when no request is in flight if you can help it: clients get an error for requests cut by the restart.
5. **Diagnose from the right place.** The journal shows `[REQUEST]`, `[EXEC]`, `[DONE]`, `[FAILED]`, `[TOOL BLOCKED]`, `[TOOL TRANSLATED]`, `[SALVAGED]` lines. What the model actually answered, and agy's own harness errors, are only in the agy run transcripts: `<sandbox base>/<profile>/.gemini/antigravity-cli/brain/<run>/.system_generated/logs/transcript.jsonl` (`transcript_full.jsonl` is untruncated).

### Quick commands (Node.js)

| Task | Command |
| :--- | :--- |
| Run unit tests | `npm test` |
| Syntax check | `node --check src/server.mjs` |
| Start locally | `npm start` (port 8008) |
| Health | `curl -s http://127.0.0.1:8008/health` |
| API keys | `node src/index.mjs key list` (see README) |

---

## 🧊 Python edition (frozen at v1.0.0) — only for an explicitly requested security fix

**NEVER modify the live `antigravity_bridge.py` directly.** Use the staging workflow:

1. `./safe_deploy.sh stage` (copies to `antigravity_bridge.py.staging`).
2. Edit `antigravity_bridge.py.staging` only.
3. `./safe_deploy.sh test antigravity_bridge.py.staging` (compiles and runs `test_antigravity_bridge.py` in an isolated `/tmp` sandbox; stop if anything fails).
4. `./safe_deploy.sh deploy antigravity_bridge.py.staging` (re-tests, backs up to `antigravity_bridge.py.bak.<timestamp>`, atomically replaces the file, restarts, polls `/health` for 15 s, rolls back automatically on failure).
5. Commit and push only after `[OK] DEPLOYMENT SUCCESSFUL`.

| Task | Command |
| :--- | :--- |
| Create / test / deploy staging copy | `./safe_deploy.sh stage` / `test` / `deploy` |
| Emergency rollback | `./safe_deploy.sh rollback` |
| Bridge status | `./safe_deploy.sh status` |
| Run unit tests directly | `python3 -m unittest test_antigravity_bridge` |
| Profile manager CLI (still the way to log profiles in for both editions) | `python3 antigravity_bridge.py profile list` |
