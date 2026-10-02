// WF-02 Alternative data: perpetual funding/marks every 5 min, news sentiment
// every 10 min. Sentiment is LLM-scored into a feature table only; it never
// places orders. Each source fails independently.
import { workflow, schedule, code, http, claude, pgFn, ifNode, cond, node } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS02AltDataCol',
  name: 'AQOS-02 Alternative data',
  active: true,
  settings: { executionTimeout: 180, saveDataSuccessExecution: 'none' },
  nodes: [
    // ---- funding and marks
    schedule('Every 5 min', { minutes: 5 }, { misfire: 'skip' }),
    code('Funding sources', 'wf02-funding-sources.js'),
    http('Fetch funding', { url: '={{ $json.url }}', timeoutMs: 10000, retries: 2, retryWaitMs: 2000, neverError: true, fullResponse: true, onError: 'continueRegularOutput' }),
    code('Normalize funding', 'wf02-normalize-funding.js'),
    pgFn('Upsert funding', 'md.upsert_funding', { payload: '$json' }),
    // ---- sentiment
    schedule('Every 10 min', { minutes: 10 }, { misfire: 'skip' }),
    http('Fetch headlines', {
      url: 'http://data-adapter:8080/v1/headlines', query: { since: '15m' }, cred: 'dataAdapterAuth', timeoutMs: 15000, retries: 2, retryWaitMs: 3000, onError: 'continueRegularOutput',
      note: 'Custom adapter (see docs): licensed news / on-chain alert providers are normalised behind one endpoint.',
    }),
    code('Split headlines', 'wf02-split-headlines.js'),
    node('Hash headline', 'n8n-nodes-base.crypto', {
      action: 'hash', binaryData: false, type: 'SHA256', value: '={{ $json.hash_input }}', dataPropertyName: 'hash', encoding: 'hex',
    }),
    code('Batch headlines', 'wf02-batch-headlines.js'),
    pgFn('New headlines', 'alt.filter_new_headlines', { payload: '$json' }),
    ifNode('Any new?', [cond('={{ $json.r.count }}', 'number:gt', 0)]),
    code('Build sentiment request', 'wf02-sentiment-request.js'),
    claude('Claude sentiment'),
    code('Sentiment result', 'wf02-sentiment-result.js'),
    pgFn('Record sentiment', 'alt.record_sentiment', { payload: '$json' }),
  ],
  connections: [
    ['Every 5 min', 'Funding sources'],
    ['Funding sources', 'Fetch funding'],
    ['Fetch funding', 'Normalize funding'],
    ['Normalize funding', 'Upsert funding'],
    ['Every 10 min', 'Fetch headlines'],
    ['Fetch headlines', 'Split headlines'],
    ['Split headlines', 'Hash headline'],
    ['Hash headline', 'Batch headlines'],
    ['Batch headlines', 'New headlines'],
    ['New headlines', 'Any new?'],
    ['Any new?', 'Build sentiment request', { out: 'true' }],
    ['Build sentiment request', 'Claude sentiment'],
    ['Claude sentiment', 'Sentiment result'],
    ['Sentiment result', 'Record sentiment'],
  ],
});
