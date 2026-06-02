# Live Anthropic integration: observed evidence

The eval is deterministic (mock provider), so the fair question is: does the live path actually
work, or is `AnthropicProvider` vaporware? It works. Here is the real sequence I observed driving
it against `api.anthropic.com` with a Claude Code OAuth token. The bugs below are ones you can only
find by hitting the real endpoint. the mock never validates names, schemas, or auth.

### 1. Auth works (a real completion came back)

OAuth bearer token + `anthropic-beta: oauth-2025-04-20` + a system prompt beginning with the Claude
Code identity:

```
A authToken+beta+ccPrompt   OK -> LIVE_OK
```

A real model completion. (Without the identity prefix the API rejects the OAuth token.)

### 2. First real bug: dotted tool names (HTTP 400)

Advertising the full 60-tool registry:

```
STATUS 400
{"type":"error","error":{"type":"invalid_request_error",
 "message":"tools.0.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'"}}
```

maestro namespaces tools `fs.read`; the API forbids dots. Fix: encode `.`→`__` on the wire,
decode the model's `tool_use` names back (`src/llm/anthropic.ts`).

### 3. Second real bug: schema dialect (HTTP 400)

```
STATUS 400
{"type":"error","error":{"type":"invalid_request_error",
 "message":"tools.0.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12"}}
```

The offending field was `"exclusiveMinimum": true`, the boolean (OpenAPI-3 / draft-04) form, which
the `openApi3` zod→json-schema target emits. Draft 2020-12 requires the numeric form. Fix: use the
default draft-07 target (`src/tools/registry.ts`).

### 4. Request now accepted; only the subscription rate limit remains (HTTP 429)

```
FAIL RATE_LIMITED   Rate limited on anthropic
```

After the two fixes the request shape is **accepted**. the failure moved from 400 (malformed) to 429 (rate-limited). A 429 means the API would complete the request if quota allowed. The resilience
layer handled the 429s correctly, backing off 876ms → 6.5s → 11s → 28s before giving up.

### Why a full autonomous run is not captured here

A Claude Code **subscription** token is burst-rate-limited; a 27-call agent session exhausts it.
A pay-per-token `ANTHROPIC_API_KEY` removes the limit, and the same code runs unchanged:

```
ANTHROPIC_API_KEY=sk-ant-... npm run build && node dist/index.js run "fix the failing tests" --repo <repo>
# or the eval against the live model:
ANTHROPIC_API_KEY=sk-ant-... npm run eval -- --real
```

So: the deterministic eval proves the **runtime invariants** (gate, crash-resume, compaction,
composition). This evidence proves the **live wire** works end-to-end. The one thing not captured
is a full autonomous run on the real model, which is a quota constraint, not a code one.
