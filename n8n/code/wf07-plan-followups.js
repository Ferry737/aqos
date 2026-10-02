// After the database applied the ratcheted mode changes: mirror the global
// mode into the Redis fast flag (DB result is authoritative) and pass on
// kill requests and the alert payload.
const evalOut = $('Evaluate breakers').first().json;
const r = $input.first().json.r ?? { changed: [] };
const globalChange = (r.changed ?? []).find((x) => x.scope === 'global');
return [{
  json: {
    ...evalOut,
    mirror_global_mode: globalChange ? globalChange.mode : null,
    changed: r.changed ?? [],
  },
}];
