// AQOS workflow DSL. Specs in n8n/specs/*.spec.mjs describe a workflow as
//   workflow({ id, name, nodes: [...], connections: [...] })
// built from the factories below; tools/build-workflows.mjs turns that into
// importable n8n JSON, and tools/validate-workflows.mjs checks every node
// against the real n8n 2.41 catalog. The factories encode AQOS policy:
//  * SQL is parameterised: user data only reaches Postgres through $1::jsonb
//  * every HTTP call has an explicit timeout; LLM calls use the right headers
//  * retries only where the callee is idempotent
import { credRef } from './credentials.mjs';

export const ERROR_WORKFLOW_ID = 'AQOS13ErrorHandl';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const V = {
  'n8n-nodes-base.webhook': 2.1, 'n8n-nodes-base.scheduleTrigger': 1.4, 'n8n-nodes-base.executeWorkflowTrigger': 1.2,
  'n8n-nodes-base.errorTrigger': 1, 'n8n-nodes-base.stripeTrigger': 1, 'n8n-nodes-base.manualTrigger': 1,
  'n8n-nodes-base.code': 2, 'n8n-nodes-base.if': 2.3, 'n8n-nodes-base.switch': 3.4, 'n8n-nodes-base.set': 3.5,
  'n8n-nodes-base.merge': 3.2, 'n8n-nodes-base.filter': 2.3, 'n8n-nodes-base.noOp': 1, 'n8n-nodes-base.stopAndError': 1,
  'n8n-nodes-base.wait': 1.1, 'n8n-nodes-base.executeWorkflow': 1.4, 'n8n-nodes-base.respondToWebhook': 1.5,
  'n8n-nodes-base.httpRequest': 4.5, 'n8n-nodes-base.postgres': 2.7, 'n8n-nodes-base.postgresTool': 2.7, 'n8n-nodes-base.redis': 1,
  'n8n-nodes-base.crypto': 2, 'n8n-nodes-base.executionData': 1.1, 'n8n-nodes-base.splitInBatches': 3, 'n8n-nodes-base.splitOut': 1,
  'n8n-nodes-base.aggregate': 1, 'n8n-nodes-base.limit': 1, 'n8n-nodes-base.emailSend': 2.1, 'n8n-nodes-base.slack': 2.7,
  'n8n-nodes-base.telegram': 1.2, 'n8n-nodes-base.pagerDuty': 1, 'n8n-nodes-base.dateTime': 2,
  '@n8n/n8n-nodes-langchain.agent': 3.1, '@n8n/n8n-nodes-langchain.lmChatAnthropic': 1.6,
  '@n8n/n8n-nodes-langchain.outputParserStructured': 1.3, '@n8n/n8n-nodes-langchain.toolThink': 1.1,
  '@n8n/n8n-nodes-langchain.toolWorkflow': 2.2, '@n8n/n8n-nodes-langchain.guardrails': 2,
};

// --- generic node -----------------------------------------------------------
// opts: { typeVersion, cred: 'postgres' | { key: 'logicalKey' ... } | ['a','b'], retry: {tries, waitMs},
//         onError, alwaysOutputData, executeOnce, note, outputs: ['true','false'] }
export function node(name, type, parameters = {}, opts = {}) {
  const n = { name, type, typeVersion: opts.typeVersion ?? V[type], parameters };
  if (n.typeVersion === undefined) throw new Error(`no default typeVersion for ${type}; pass opts.typeVersion`);
  const creds = [].concat(opts.cred ?? []);
  if (creds.length) {
    n.credentials = {};
    for (const key of creds) {
      const { type: ctype, ref } = credRef(key);
      n.credentials[ctype] = ref;
    }
  }
  if (opts.retry) { n.retryOnFail = true; n.maxTries = opts.retry.tries ?? 3; n.waitBetweenTries = opts.retry.waitMs ?? 1000; }
  if (opts.onError) n.onError = opts.onError;
  if (opts.alwaysOutputData) n.alwaysOutputData = true;
  if (opts.executeOnce) n.executeOnce = true;
  if (opts.note) { n.notes = opts.note; n.notesInFlow = false; }
  if (opts.outputs) n.__outputs = opts.outputs;
  return n;
}

// --- triggers -----------------------------------------------------------------
export const webhook = (name, { path, method = 'POST', auth = 'inbound', rawBody = false, respond = 'responseNode', note } = {}) =>
  node(name, 'n8n-nodes-base.webhook', {
    httpMethod: method,
    path,
    authentication: auth === 'none' ? 'none' : 'headerAuth',
    responseMode: respond,
    options: rawBody ? { rawBody: true } : {},
  }, { cred: auth === 'none' ? [] : [auth === 'ops' ? 'opsAuth' : 'inboundAuth'], note });

// every: { seconds } | { minutes } | { hours } | { cron: '...' }; misfire: 'skip' | 'coalesce'
export const schedule = (name, every, { misfire = 'skip', graceS = 0, note } = {}) => {
  let interval;
  if (every.seconds) interval = { field: 'seconds', secondsInterval: every.seconds };
  else if (every.minutes) interval = { field: 'minutes', minutesInterval: every.minutes };
  else if (every.hours) interval = { field: 'hours', hoursInterval: every.hours };
  else if (every.cron) interval = { field: 'cronExpression', expression: every.cron };
  else throw new Error('schedule() needs seconds, minutes, hours or cron');
  return node(name, 'n8n-nodes-base.scheduleTrigger', {
    rule: { interval: [interval] }, misfirePolicy: misfire, misfireGraceSeconds: graceS,
  }, { note });
};

// Sub-workflows accept all data (passthrough): callers pass items, no input mapping needed.
export const execTrigger = (name, { note } = {}) =>
  node(name, 'n8n-nodes-base.executeWorkflowTrigger', { inputSource: 'passthrough' }, { note });
export const errorTrigger = (name) => node(name, 'n8n-nodes-base.errorTrigger', {});
export const stripeTrigger = (name, events) => node(name, 'n8n-nodes-base.stripeTrigger', { events }, { cred: 'stripe' });

// --- data -----------------------------------------------------------------------
// replace: { __TOKEN__: 'text' } substituted in the script at build time (e.g. a node name).
export const code = (name, file, { replace, note } = {}) =>
  node(name, 'n8n-nodes-base.code', { mode: 'runOnceForAllItems', __script: file, ...(replace ? { __replace: replace } : {}) }, { note });

// Parameterised SQL only. params: expression (default sends the whole item as jsonb $1).
export function pg(name, sql, { params = '={{ JSON.stringify($json) }}', retry = true, onError, note, alwaysOutputData, executeOnce } = {}) {
  if (/\{\{|\$\{/.test(sql)) throw new Error(`pg("${name}"): SQL must not contain expressions; pass data through params`);
  return node(name, 'n8n-nodes-base.postgres', {
    operation: 'executeQuery', query: sql, options: params === null ? {} : { queryReplacement: params },
  }, { cred: 'postgres', retry: retry ? { tries: 3, waitMs: 1000 } : undefined, onError, note, alwaysOutputData, executeOnce });
}
// Calls one of the schema's single-jsonb-argument functions.
//   scalar:  SELECT schema.fn($1::jsonb) AS r        setof: SELECT * FROM schema.fn($1::jsonb)
export const pgFn = (name, fn, { as = 'r', setof = false, payload = '$json', ...rest } = {}) =>
  pg(name, setof ? `SELECT * FROM ${fn}($1::jsonb)` : `SELECT ${fn}($1::jsonb) AS ${as}`,
    { params: `={{ JSON.stringify(${payload}) }}`, ...rest });

export const redisGet = (name, key, prop, opts = {}) =>
  node(name, 'n8n-nodes-base.redis', { operation: 'get', propertyName: prop, key, keyType: 'string' },
    { cred: 'redis', retry: { tries: 3, waitMs: 500 }, ...opts });
export const redisSet = (name, key, value, { ttlS, ...opts } = {}) =>
  node(name, 'n8n-nodes-base.redis', { operation: 'set', key, value, keyType: 'string', expire: !!ttlS, ...(ttlS ? { ttl: ttlS } : {}) },
    { cred: 'redis', retry: { tries: 3, waitMs: 500 }, ...opts });
export const redisIncr = (name, key, { ttlS, ...opts } = {}) =>
  node(name, 'n8n-nodes-base.redis', { operation: 'incr', key, expire: !!ttlS, ...(ttlS ? { ttl: ttlS } : {}) }, { cred: 'redis', ...opts });
export const redisDelete = (name, key, opts = {}) =>
  node(name, 'n8n-nodes-base.redis', { operation: 'delete', key }, { cred: 'redis', ...opts });
export const redisPublish = (name, channel, message, opts = {}) =>
  node(name, 'n8n-nodes-base.redis', { operation: 'publish', channel, messageData: message }, { cred: 'redis', ...opts });

// --- HTTP -------------------------------------------------------------------------
// cred: key from tools/lib/credentials.mjs (httpHeaderAuth credentials). body: object or expression string.
// retries > 0 only for idempotent calls (reads, or writes keyed by an idempotency id).
export function http(name, { method = 'GET', url, cred, headers, query, body, timeoutMs = 10000, retries = 0, retryWaitMs = 2000,
  neverError = false, fullResponse = false, onError, note, executeOnce } = {}) {
  const p = { method, url, authentication: cred ? 'genericCredentialType' : 'none' };
  if (cred) p.genericAuthType = 'httpHeaderAuth';
  if (headers) { p.sendHeaders = true; p.specifyHeaders = 'keypair'; p.headerParameters = { parameters: Object.entries(headers).map(([k, v]) => ({ name: k, value: v })) }; }
  if (query) { p.sendQuery = true; p.specifyQuery = 'keypair'; p.queryParameters = { parameters: Object.entries(query).map(([k, v]) => ({ name: k, value: v })) }; }
  if (body !== undefined) {
    p.sendBody = true; p.contentType = 'json'; p.specifyBody = 'json';
    p.jsonBody = typeof body === 'string' ? body : JSON.stringify(body);
  }
  p.options = { timeout: timeoutMs };
  if (neverError || fullResponse) p.options.response = { response: { ...(fullResponse ? { fullResponse: true } : {}), ...(neverError ? { neverError: true } : {}) } };
  return node(name, 'n8n-nodes-base.httpRequest', p, {
    cred: cred ? [cred] : [], retry: retries > 0 ? { tries: retries, waitMs: retryWaitMs } : undefined, onError, note, executeOnce,
    ...(onError === 'continueErrorOutput' ? { outputs: ['success', 'error'] } : {}),
  });
}

// Claude Messages API call. The request body is built by a preceding Code node
// (n8n/code/common-claude.js claudeRequest) into $json.anthropic_request. The
// node never throws into the main path: errors become items with .error and
// the next Code node's parseClaude() maps every failure to a deterministic fallback.
export const claude = (name, { requestExpr = '={{ JSON.stringify($json.anthropic_request) }}', timeoutMs = 120000, note } = {}) =>
  node(name, 'n8n-nodes-base.httpRequest', {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'anthropicApi',
    sendHeaders: true,
    specifyHeaders: 'keypair',
    headerParameters: { parameters: [
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'anthropic-beta', value: ANTHROPIC_FALLBACK_BETA },
    ] },
    sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: requestExpr,
    options: { timeout: timeoutMs, response: { response: { fullResponse: true, neverError: true } } },
  }, { cred: 'anthropic', onError: 'continueRegularOutput', note });

// --- conditions -------------------------------------------------------------------
// cond(left, 'type:operation', right?) e.g. cond('={{ $json.valid }}', 'boolean:true')
const UNARY = new Set(['true', 'false', 'exists', 'notExists', 'empty', 'notEmpty']);
export function cond(left, op, right) {
  const [type, operation] = op.split(':');
  const o = { type, operation };
  if (UNARY.has(operation)) o.singleValue = true;
  return { leftValue: left, rightValue: right ?? '', operator: o };
}
const filterBlock = (conds, combinator = 'and') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 3 },
  conditions: conds.map((c) => ({ id: '', ...c })), // ids are filled by the builder
  combinator,
});
export const ifNode = (name, conds, { combinator = 'and', note } = {}) =>
  node(name, 'n8n-nodes-base.if', { conditions: filterBlock(conds, combinator), looseTypeValidation: true, options: {} },
    { outputs: ['true', 'false'], note });
// rules: [{ key: 'proceed', conds: [...], combinator? }]; fallback: name of the extra output or null
export const switchNode = (name, rules, { fallback = null, note } = {}) =>
  node(name, 'n8n-nodes-base.switch', {
    mode: 'rules',
    rules: { values: rules.map((r) => ({ conditions: filterBlock(r.conds, r.combinator), renameOutput: true, outputKey: r.key })) },
    looseTypeValidation: true,
    options: fallback ? { fallbackOutput: 'extra', renameFallbackOutput: fallback } : {},
  }, { outputs: [...rules.map((r) => r.key), ...(fallback ? [fallback] : [])], note });

// --- flow ----------------------------------------------------------------------------
export const noop = (name, note) => node(name, 'n8n-nodes-base.noOp', {}, { note });
export const stopError = (name, message) => node(name, 'n8n-nodes-base.stopAndError', { errorType: 'errorMessage', errorMessage: message });
export const merge = (name, { mode = 'append', numberInputs = 2, ...extra } = {}) =>
  node(name, 'n8n-nodes-base.merge', { mode, numberInputs, ...extra });
export const execWf = (name, workflowId, { mode = 'once', wait = true, note } = {}) =>
  node(name, 'n8n-nodes-base.executeWorkflow', {
    source: 'database',
    workflowId: { __rl: true, value: workflowId, mode: 'id' },
    mode,
    options: { waitForSubWorkflow: wait },
  }, { note });
export const respond = (name, { code: status = 200, body = '={{ { ok: true } }}', note } = {}) =>
  node(name, 'n8n-nodes-base.respondToWebhook', {
    respondWith: 'json', responseBody: typeof body === 'string' ? body : JSON.stringify(body), options: { responseCode: status },
  }, { note });
export const waitSeconds = (name, seconds) => node(name, 'n8n-nodes-base.wait', { resume: 'timeInterval', amount: seconds, unit: 'seconds' });
// Pauses the execution until a link is opened (or the time limit passes).
export const waitForLink = (name, { hours = 4, method = 'GET' } = {}) =>
  node(name, 'n8n-nodes-base.wait', {
    resume: 'webhook', httpMethod: method, responseMode: 'onReceived', limitWaitTime: true,
    limitType: 'afterTimeInterval', resumeAmount: hours, resumeUnit: 'hours',
  });
export const splitInBatches = (name, size = 10) => node(name, 'n8n-nodes-base.splitInBatches', { batchSize: size, options: {} }, { outputs: ['done', 'loop'] });
export const hmacOfRawBody = (name, { prop = 'computed_sig' } = {}) =>
  node(name, 'n8n-nodes-base.crypto', {
    action: 'hmac', binaryData: true, binaryPropertyName: 'data', type: 'SHA256', dataPropertyName: prop, encoding: 'hex',
  }, { cred: 'hmac' });
// assignments: { field: primitive | { expr: '={{ ... }}', type: 'number' } }
export function setFields(name, assignments, { keepOthers = true } = {}) {
  const list = Object.entries(assignments).map(([k, v]) => {
    if (v && typeof v === 'object' && 'expr' in v) return { id: '', name: k, value: v.expr, type: v.type ?? 'string' };
    const type = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : Array.isArray(v) ? 'array' : v && typeof v === 'object' ? 'object' : 'string';
    return { id: '', name: k, value: v, type };
  });
  return node(name, 'n8n-nodes-base.set', { assignments: { assignments: list }, includeOtherFields: keepOthers, options: {} });
}

// --- notifications (WF-16) -------------------------------------------------------------
export const slackMessage = (name, { channel, text = '={{ $json.text }}' }) =>
  node(name, 'n8n-nodes-base.slack', {
    authentication: 'accessToken', resource: 'message', operation: 'post', select: 'channel',
    channelId: { __rl: true, value: channel, mode: 'name' }, messageType: 'text', text, otherOptions: {},
  }, { cred: 'slack', retry: { tries: 3, waitMs: 2000 } });
export const pagerdutyIncident = (name) =>
  node(name, 'n8n-nodes-base.pagerDuty', {
    authentication: 'apiToken', resource: 'incident', operation: 'create',
    title: '={{ $json.summary }}', serviceId: '@@PAGERDUTY_SERVICE_ID@@', email: '@@PAGERDUTY_FROM_EMAIL@@',
    additionalFields: { details: '={{ $json.text }}' },
  }, { cred: 'pagerduty', retry: { tries: 3, waitMs: 2000 } });
export const emailSend = (name, { to = '={{ $json.to }}', subject = '={{ $json.subject }}', html }) =>
  node(name, 'n8n-nodes-base.emailSend', {
    fromEmail: '@@MAIL_FROM@@', toEmail: to, subject, emailFormat: 'html', html, options: { appendAttribution: false },
  }, { cred: 'smtp', retry: { tries: 3, waitMs: 5000 } });

// --- AI agents (WF-09, WF-15) ------------------------------------------------------------
// Opus 5.5 cannot disable thinking and rejects forced tool use, so adaptive
// thinking is explicit and the agent's forced-first-tool option stays off.
export const lmAnthropic = (name, { effort = 'medium', maxTokens = 8000 } = {}) =>
  node(name, '@n8n/n8n-nodes-langchain.lmChatAnthropic', {
    model: { __rl: true, mode: 'id', value: 'claude-opus-5-5' },
    options: { maxTokensToSample: maxTokens, thinkingMode: 'adaptive', effort },
  }, { cred: 'anthropic' });
export const agent = (name, { text, system, maxIterations = 8, parser = false, note }) =>
  node(name, '@n8n/n8n-nodes-langchain.agent', {
    promptType: 'define', text, hasOutputParser: parser,
    options: { systemMessage: system, maxIterations, returnIntermediateSteps: false },
  }, { onError: 'continueRegularOutput', note });
export const outputParser = (name, schema) =>
  node(name, '@n8n/n8n-nodes-langchain.outputParserStructured', { schemaType: 'manual', inputSchema: JSON.stringify(schema, null, 2), autoFix: false });
// A tool that runs one fixed SQL statement under the read-only / tighten-only
// database role. Arguments come from the model via $fromAI inside params.
export const toolPostgres = (name, { description, sql, params }) =>
  node(name, 'n8n-nodes-base.postgresTool', {
    descriptionType: 'manual', toolDescription: description, operation: 'executeQuery', query: sql,
    options: params ? { queryReplacement: params } : {},
  }, { cred: 'postgresAgent' });

// --- connections ---------------------------------------------------------------------------
// chain('A','B','C') -> [['A','B'],['B','C']]
export const chain = (...names) => names.slice(1).map((n, i) => [names[i], n]);
// ai('Model', 'Agent', 'ai_languageModel') -> AI sub-node connection
export const ai = (from, to, type) => [from, to, { type }];

export function workflow(def) {
  for (const k of ['id', 'name', 'nodes', 'connections']) if (def[k] === undefined) throw new Error(`workflow(): missing "${k}"`);
  if (!/^[A-Za-z0-9]{16}$/.test(def.id)) throw new Error(`workflow id "${def.id}" must be 16 alphanumeric characters`);
  return { settings: {}, ...def };
}
