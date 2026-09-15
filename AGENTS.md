# 🛡️ Antigravity Bridge - Agent Development & Deployment Guidelines

## ⚠️ CRITICAL ARCHITECTURAL WARNING: "The Self-Hosting Danger"

`antigravity-bridge` serves as the primary live API gateway and communication channel for AI assistants (Antigravity, Hermes Agent, Cursor, Claude Code, etc.) interacting with Google Antigravity (Gemini) and Anthropic Claude.

**When an AI agent is working on this codebase, the agent ITSELF is actively communicating through this bridge.**

If an agent directly edits `antigravity_bridge.py` in-place and introduces a syntax error, NameError, unhandled exception, or broken import:
1. The bridge server crashes or rejects requests.
2. The agent's own connection to the LLM API is instantly severed.
3. The session freezes, the user is locked out with `Antigravity Bridge Error: All agy profile execution attempts failed`, and the agent cannot even receive commands to repair its mistake.

---

## 🛑 MANDATORY RULE: Staging-First Safe Modification Workflow

**NEVER modify the live `antigravity_bridge.py` directly.**

All agents and developers MUST strictly adhere to the following 5-step workflow whenever making changes to `antigravity-bridge`:

### Step 1: Create Staging Copy
Always work on a separate staging file:
```bash
./safe_deploy.sh stage
# Or manually:
cp antigravity_bridge.py antigravity_bridge.py.staging
```

### Step 2: Implement Changes in Staging Only
Perform all edits, refactors, and fixes on `antigravity_bridge.py.staging`. The live server continues running uninterrupted using `antigravity_bridge.py`.

### Step 3: Test Staging in Isolated Sandbox
Run Python compilation check and the full unit test suite in an isolated directory:
```bash
./safe_deploy.sh test antigravity_bridge.py.staging
```
* The test script copies staging code and test files to an isolated `/tmp` sandbox.
* It verifies all 57+ unit tests pass without touching the live server.
* If any test fails, STOP and fix the staging file. Do NOT deploy.

### Step 4: Atomic Deployment & Health Check
Once all unit tests pass 100%, deploy via `safe_deploy.sh`:
```bash
./safe_deploy.sh deploy antigravity_bridge.py.staging
```
This automated process:
1. Re-verifies syntax and unit tests.
2. Automatically creates a timestamped backup of the current live code:
   `antigravity_bridge.py.bak.<timestamp>` and `antigravity_bridge.py.bak`.
3. Atomically replaces `antigravity_bridge.py` with the staging file.
4. Restarts the service cleanly.
5. Polls `/health` for up to 15 seconds to ensure the bridge is healthy.
6. **Automatic Rollback:** If `/health` fails, times out, or returns an error, the script immediately rolls back to `antigravity_bridge.py.bak` and restarts the service, preventing lockout.

### Step 5: Git Commit & Push
Only after `./safe_deploy.sh deploy` completes and reports `[OK] DEPLOYMENT SUCCESSFUL`:
```bash
git add antigravity_bridge.py test_antigravity_bridge.py
git commit -m "feat/fix: description of verified changes"
git push origin main
```

---

## 🛠️ Quick Commands Reference

| Task | Command |
| :--- | :--- |
| **Create staging copy** | `./safe_deploy.sh stage` |
| **Test staging copy** | `./safe_deploy.sh test` |
| **Deploy staging copy** | `./safe_deploy.sh deploy` |
| **Emergency Rollback** | `./safe_deploy.sh rollback` |
| **Check Bridge Status** | `./safe_deploy.sh status` |
| **Run Unit Tests Directly** | `python3 -m unittest test_antigravity_bridge.py` |
| **Profile Manager CLI** | `python3 antigravity_bridge.py profile list` |
