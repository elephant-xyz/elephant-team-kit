# Elephant Team Kit

Agents, skills and the Elephant MCP server for Elephant's open county data, packaged as one plugin for Claude Code, Cursor, GitHub Copilot CLI and OpenAI Codex.

These moved here from [soofi-xyz/soofi-xyz-team-kit](https://github.com/soofi-xyz/soofi-xyz-team-kit), which no longer ships them.

## Agents

| Agent | What it does |
| --- | --- |
| `oracle` | Mines, re-mines, validates and publishes county property, permit, corporate-registry, places and contractor data as lexicon records through Atlas. Also runs HOA name, fee and frequency web scrapes and adjudication. |
| `donphan` | Explores published county records through the Elephant MCP: scoped counts and filters, contractor evidence, address mismatches, area questions and lexicon schema definitions. Not for ingestion. |
| `watchog` | Builds and extends the scheduled service that turns published Atlas county data into verified facts for the elephant.xyz homepage hero, approved in Asana and published as a content-only pull request. |

## Skills

- **County onboarding and ingestion:** `onboard-county`, `county-discovery`, `county-readiness-preflight`, `county-seed-data`, `county-appraisal-onboarding`, `county-permit-adapter`, `county-ingest-run`, `build-county-transform`, `bootstrap-oracle-infra`, `durable-workflow-builder`, `query-db-loading-matching`, `monitoring-county-ingestion`, `monitoring-oracle-ingestion`
- **Enrichment:** `bbb-harvest`, `dbpr-license-ingest`, `sunbiz-corporate-ingest`, `overture-places-ingest`
- **Mortgages:** `mortgage-index-harvest` (recorded mortgages, deeds of trust and security deeds from county official records)
- **Oracle and the Elephant MCP:** `use-oracle` (with its bundled runtime under `skills/use-oracle/runtime/`), `use-elephant-mcp`, `deploy-open-data-mcp`, `migrate-elephant-cli-v2`
- **Hero facts:** `build-elephant-hero-facts`
- **Shared engineering skills:** `apply-engineering-guidelines`, `build-ai-agents`, `build-batch-workflows`, `integrate-ci-cd`, `babysit-release`. These are also in soofi-xyz-team-kit.

## MCP server

The plugin adds the `elephant` MCP server (`mcp.json`), which serves the published Atlas county data. It needs **Node 22.18 or later** on your `PATH`, and it starts with `npx`, so the first start takes a moment.

## Install

### Claude Code

```text
/plugin marketplace add elephant-xyz/elephant-team-kit
/plugin install elephant-team-kit@elephant-xyz
```

Update it later with `/plugin marketplace update elephant-xyz`.

### Cursor

Clone the repository and link it as a local plugin:

```bash
git clone https://github.com/elephant-xyz/elephant-team-kit ~/.cursor/plugins/local/elephant-team-kit
```

Reload Cursor. The agents, skills and the `elephant` MCP server appear under the plugin. Update it with `git -C ~/.cursor/plugins/local/elephant-team-kit pull`.

### GitHub Copilot CLI and Codex

The repository also carries a Copilot plugin (`plugin.json`, `.github/plugin/marketplace.json`) and a Codex plugin (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`). Add the repository as a marketplace in either tool.

### Moving from soofi-xyz-team-kit

If you used these agents from soofi-xyz-team-kit, install this plugin. Once soofi-xyz-team-kit drops them, its next update removes oracle, donphan, watchog and the `elephant` MCP server.

## Working on this repository

- **Source files:** `agents/*.md` holds the source agents. `agents-claude/`, `agents-copilot/` and `.codex/agents/` are generated from it: after editing an agent, run `scripts/sync-copilot-agents.sh sync`, `scripts/sync-codex-agents.sh sync` and `scripts/sync-claude-agents.sh sync`.
- **Checks:** `scripts/validate-plugin.sh` and `python3 scripts/check-plugin-clean-room.py` must pass. CI runs both, plus the Oracle runtime tests.
- **Releases:** bump `version` in every manifest and marketplace entry for each release. Claude Code only updates when the version changes.

## License

MIT
