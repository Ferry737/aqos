# AQOS: Agentic Quant OS

An AI-native, 24/7 trading operating system for crypto, built as an n8n control plane over a Postgres system of record. This repo holds the schema, 17 generated n8n workflows, the Code-node logic, verification tooling and the business and architecture documents.

**Start here:** [docs/blueprint.md](docs/blueprint.md) (business, architecture, AI agents, n8n design) and [docs/business-strategy.md](docs/business-strategy.md).

## Status

Control plane built and tested. Market-facing services (EMS, risk, model, portfolio, stream gateway, data adapter) are specified, not built. Nothing here claims performance. See blueprint section 0 and section 9.

## Quick start

```bash
npm install
npm run verify        # build workflows, validate against the n8n 2.41.4 catalog, run all tests
```

| Command | What it does |
|---|---|
| `npm run build` | Generate `n8n/workflows/*.json` from `n8n/specs/*.spec.mjs` |
| `npm run validate` | Check every node, parameter, credential, SQL function and Code script; writes `docs/feasibility.json` |
| `npm run test:db` | Run `db/schema.sql` in PGlite (Postgres 17) and check the safety invariants |
| `npm run test:validator` | Prove the validator fails on broken workflows |
| `npm run test:logic` | Unit tests for the Code-node scripts |
| `npm run credentials` | Write `deploy/credentials.template.json` (placeholders only) |
| `node tools/check-openapi.mjs docs/openapi` | Structural check of the 13 service contracts |
| `node tools/mutation-check.mjs` | Break the risk gate on purpose; the tests must fail every time |
| `bash orchestration/pipeline.sh` | Run the free-model agent team unattended behind an acceptance gate |
| `node tools/monitor.mjs <runsDir>` | "Obsidian Logs": live, per-second UI of the agent team at http://127.0.0.1:8787 |

## Deploy (reference, single host)

1. `cp deploy/.env.example deploy/.env` and fill in secrets. Copy `deploy/config.example.json` to `deploy/config.json` and edit.
2. `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`
3. Load the schema: `psql "$DATABASE_URL" -f db/schema.sql`. Do **not** load `db/seed_example.sql` outside development: its limits are placeholders.
4. Import credentials, then workflows, inside the n8n container:
   `n8n import:credentials --input=deploy/credentials.template.json` then `n8n import:workflow --separate --input=n8n/workflows`.
   Fill in the real secrets in n8n. Workflow ids are fixed, so sub-workflow links resolve.
5. Publish the workflows marked active. In queue or multi-main mode, `--activeState=fromJson` can do it at import.
6. Build the custom services listed in `docs/feasibility.json`, or point the hostnames at stubs for a dry run.

The risk limits in `risk.limits` must be calibrated and approved by a risk committee before any live use.

## Layout

```
db/            schema.sql, seed_example.sql
n8n/specs/     workflows as code (DSL in tools/lib/dsl.mjs)
n8n/code/      Code-node scripts (shared helpers inlined with //@include)
n8n/workflows/ generated, importable JSON
tools/         builder, validator, catalog snapshot, tests
deploy/        compose file, templates
docs/          blueprint, strategy, feasibility
orchestration/ task briefs + dispatcher for delegating work to free-model agents
```

## Safety design in one paragraph

An order exists only if the database holds an unexpired, single-use risk token for it. Risk modes only escalate; lifting a halt needs two approvers. AI agents can tighten limits and demote models, never loosen or promote. No LLM is on the order path. Venue state is the source of truth and reconciliation adopts it. Every state change lands in a hash-chained audit log.

Not investment advice. Digital assets are volatile and capital can be lost.
