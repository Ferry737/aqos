// Credential placeholders. Workflows reference credentials by fixed id and
// name, so importing deploy/credentials.template.json (placeholders only, no
// secrets) makes every reference resolve. Real secrets are entered in n8n or
// injected from the vault; they never appear in workflow JSON.
export const CREDENTIALS = {
  postgres:        { type: 'postgres',       id: 'aqosCredPgMain00', name: 'AQOS Postgres' },
  postgresAgent:   { type: 'postgres',       id: 'aqosCredPgAgent00', name: 'AQOS Postgres (agent read-only)' },
  redis:           { type: 'redis',          id: 'aqosCredRedis0000', name: 'AQOS Redis' },
  anthropic:       { type: 'anthropicApi',   id: 'aqosCredAnthrop00', name: 'AQOS Anthropic' },
  hmac:            { type: 'crypto',         id: 'aqosCredHmac00000', name: 'AQOS Webhook HMAC' },
  inboundAuth:     { type: 'httpHeaderAuth', id: 'aqosCredInbound00', name: 'AQOS Inbound Webhook Token' },
  opsAuth:         { type: 'httpHeaderAuth', id: 'aqosCredOpsAuth00', name: 'AQOS Ops Webhook Token' },
  emsAuth:         { type: 'httpHeaderAuth', id: 'aqosCredEmsAuth00', name: 'AQOS EMS Token' },
  riskSvcAuth:     { type: 'httpHeaderAuth', id: 'aqosCredRiskSvc00', name: 'AQOS Risk Service Token' },
  modelSvcAuth:    { type: 'httpHeaderAuth', id: 'aqosCredModelSv00', name: 'AQOS Model Service Token' },
  portfolioSvcAuth:{ type: 'httpHeaderAuth', id: 'aqosCredPortSvc00', name: 'AQOS Portfolio Service Token' },
  streamGwAuth:    { type: 'httpHeaderAuth', id: 'aqosCredStreamGw0', name: 'AQOS Stream Gateway Token' },
  dataAdapterAuth: { type: 'httpHeaderAuth', id: 'aqosCredDataAdp00', name: 'AQOS Data Adapter Token' },
  screeningAuth:   { type: 'httpHeaderAuth', id: 'aqosCredScreen000', name: 'AQOS Screening Provider' },
  slack:           { type: 'slackApi',       id: 'aqosCredSlack0000', name: 'AQOS Slack' },
  telegram:        { type: 'telegramApi',    id: 'aqosCredTelegram0', name: 'AQOS Telegram' },
  pagerduty:       { type: 'pagerDutyApi',   id: 'aqosCredPagerDty0', name: 'AQOS PagerDuty' },
  smtp:            { type: 'smtp',           id: 'aqosCredSmtp00000', name: 'AQOS SMTP' },
  stripe:          { type: 'stripeApi',      id: 'aqosCredStripe000', name: 'AQOS Stripe' },
};

export const credRef = (key) => {
  const c = CREDENTIALS[key];
  if (!c) throw new Error(`unknown credential key "${key}"; known: ${Object.keys(CREDENTIALS).join(', ')}`);
  return { type: c.type, ref: { id: c.id, name: c.name } };
};
