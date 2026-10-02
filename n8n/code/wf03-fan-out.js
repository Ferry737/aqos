// One item per proposal, shuffled every cycle so that no client is
// systematically first when many accounts trade the same signal. Strategy
// capacity is shared pro-rata inside the gate regardless of order.
const props = [...($('Prepare cycle outputs').first().json.proposals ?? [])];
for (let i = props.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [props[i], props[j]] = [props[j], props[i]];
}
return props.map((p) => ({ json: p }));
