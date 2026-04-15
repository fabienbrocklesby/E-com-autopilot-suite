# Claude Code Setup

## Install (if you haven't)

```bash
npm install -g @anthropic-ai/claude-code
```

Or if you already have it, make sure it's current:
```bash
npm update -g @anthropic-ai/claude-code
```

## Setup for this project

1. **Copy the files into your repo root:**

```bash
# From this bundle:
cp CLAUDE.md /path/to/e-com-autopilot-suite/CLAUDE.md
cp .mcp.json /path/to/e-com-autopilot-suite/.mcp.json
cp api/CLAUDE.md /path/to/e-com-autopilot-suite/api/CLAUDE.md
cp frontend/CLAUDE.md /path/to/e-com-autopilot-suite/frontend/CLAUDE.md
```

2. **Fix the Postgres connection string in `.mcp.json`:**

Open `.mcp.json` and verify the connection string matches your Docker setup:
```json
"postgres://emaildash:changeme@localhost:5432/emaildash"
```

Adjust username, password, host, port, and database name if yours differ. Check your `docker-compose.yml` for the actual values.

3. **Make sure Docker is running:**

```bash
cd /path/to/e-com-autopilot-suite
docker compose up -d
```

4. **Start Claude Code in the repo:**

```bash
cd /path/to/e-com-autopilot-suite
claude
```

5. **Verify MCP servers are connected:**

Once Claude Code starts, it should auto-detect the `.mcp.json` and connect to the servers. Type:

```
/mcp
```

You should see postgres, context7, and playwright listed as connected. If any show as disconnected, check the error and fix the config.

6. **Verify Claude reads the CLAUDE.md:**

Ask: "What stack does this project use?"

It should answer Deno + Hono + Postgres + SvelteKit 5. If it says Go or React or anything else, the CLAUDE.md isn't being loaded. Check the file exists at the repo root.

## Run the fix prompt

Once everything is connected, paste the contents of `PROMPT.md` into the Claude Code chat. Or reference it:

```
Read PROMPT.md and execute it step by step.
```

Claude Code will read the file and start working through the steps.

## What Claude Code does differently from Copilot

- It reads files directly (no MCP needed for filesystem — it has native file access)
- It runs terminal commands directly (no MCP needed for bash)
- MCP servers are for EXTERNAL tools: postgres queries, browser automation, doc fetching
- It manages its own context window — you'll see it summarize long conversations
- It asks for permission before editing files or running commands (configurable)

## Tips for this session

- Let it read everything in Step 1 before it starts coding. Don't rush it.
- When it shows you a diff, actually read it. Especially the evaluate handler changes.
- When it runs the test scenarios, watch the postgres output. The execution trace tells you if it's really working.
- If it says "I've completed X" — ask it to prove it with a postgres query. Trust but verify.

## After the session

If everything passes, commit the changes:

```bash
git add -A
git commit -m "fix: production-ready playbook engine — evaluate handler, design guide, action banner, escalation reasons"
```

Then test with your client's real email patterns. Send a few test emails that match the categories they care about and verify the playbooks handle them correctly.
