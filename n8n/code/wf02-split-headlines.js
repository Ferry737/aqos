// One item per headline from the data adapter. The Crypto node that follows
// hashes source|title into a stable dedupe key.
const items = $input.first().json.items ?? [];
return items
  .filter((h) => h && typeof h.title === 'string' && h.title.trim())
  .slice(0, 200)
  .map((h) => ({
    json: {
      source: String(h.source ?? 'unknown').slice(0, 80),
      title: h.title.trim().slice(0, 400),
      url: h.url ?? null,
      published_at: h.published_at ?? null,
      symbols: Array.isArray(h.symbols) ? h.symbols.slice(0, 10) : [],
      hash_input: `${h.source ?? 'unknown'}|${h.title.trim().toLowerCase()}`,
    },
  }));
