// One item per kill request for the Kill Switch sub-workflow.
const src = $('__SOURCE__').first().json;
const kills = src.kills ?? [];
return kills.map((k) => ({ json: k }));
