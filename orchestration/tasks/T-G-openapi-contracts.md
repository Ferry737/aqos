# TASK T-G: OpenAPI contracts for the custom services

Deliverables: `docs/openapi/ems.json` (the six EMS endpoints plus a `webhooks` section) and `docs/openapi/services.json` (stream-gw, data-adapter, model-svc, portfolio-svc, risk-svc: seven endpoints). Create the `docs/openapi/` folder. Acceptance: `node tools/check-openapi.mjs docs/openapi`.

Read `CONTRACTS.md` (in this directory): it is the source of truth. Write OpenAPI **3.1 as JSON**, one file per group:
- `info`, `servers` (placeholder URLs like `http://ems:8080`), `components.securitySchemes` with a bearer scheme, global `security`.
- Every operation: summary, `requestBody` (POST) with an `application/json` schema that has `properties`, `required` and `additionalProperties: false` where sensible, a `200` response schema with `properties`, and `401`, `422`, `503` error responses referencing a shared `Error` schema in `components.schemas`.
- Use `$ref` into `components.schemas` for shared objects (Order, Prediction, Proposal, Position, Error).
- `ems.json` must also have a top-level `webhooks` object describing the signed `aqos-event` pushed to n8n (envelope schema plus the four payload types as `oneOf` or described in the schema), including the signature header in the description.
- Add `description` text on idempotency (`parent_order_id`, `request_id`) and on the model-service determinism rule.
Keep it consistent with `CONTRACTS.md` exactly (field names, types, enums).
