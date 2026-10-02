// WF-16 Notifier: the single place ops alerts are routed. SEV1 pages on-call
// and posts to chat; everything else posts to chat only.
import { workflow, execTrigger, code, ifNode, cond, slackMessage, pagerdutyIncident } from '../../tools/lib/dsl.mjs';

export default workflow({
  id: 'AQOS16Notifier00',
  name: 'AQOS-16 Notifier',
  settings: { executionTimeout: 60, saveDataSuccessExecution: 'none' },
  nodes: [
    execTrigger('Alert in'),
    code('Route alert', 'wf16-route-alert.js'),
    slackMessage('Post to ops chat', { channel: '@@SLACK_OPS_CHANNEL@@' }),
    ifNode('Is SEV1', [cond('={{ $json.severity }}', 'string:equals', 'SEV1')]),
    pagerdutyIncident('Page on-call'),
  ],
  connections: [
    ['Alert in', 'Route alert'],
    ['Route alert', 'Post to ops chat'],
    ['Route alert', 'Is SEV1'],
    ['Is SEV1', 'Page on-call', { out: 'true' }],
  ],
});
