# Agent guidance for this repository

This repository is a Cursor, GitHub Copilot CLI, OpenAI Codex and Claude Code plugin with Elephant's open-data agents and skills.

- `agents/` is the source of truth. Never edit `agents-copilot/`, `.codex/agents/` or `agents-claude/` by hand. After any agent change, run `scripts/sync-copilot-agents.sh sync`, `scripts/sync-codex-agents.sh sync` and `scripts/sync-claude-agents.sh sync`. The Claude sync also rewrites the `agents` list in `.claude-plugin/plugin.json`.
- Each skill is `skills/<name>/SKILL.md` and stays under 500 lines. Its frontmatter `name` matches the directory, and it carries a `description` saying what the skill does and when to use it.
- Bump `version` in every plugin manifest and marketplace entry (`.claude-plugin/`, `.cursor-plugin/`, `.codex-plugin/`, `plugin.json`, `.github/plugin/marketplace.json`) when you ship a change.
- Keep the Oracle runtime self-contained: no tracked `node_modules/`, `downloads/`, `.env*` (except `.env.example`) or generated parcel artifacts.
- Before a pull request, run `scripts/validate-plugin.sh` and `python3 scripts/check-plugin-clean-room.py`.
