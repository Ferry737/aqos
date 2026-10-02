// Collapse hashed headlines into one payload for alt.filter_new_headlines,
// which inserts unseen ones and returns only those.
return [{
  json: {
    items: $input.all().map(({ json: h }) => ({
      hash: h.hash, source: h.source, title: h.title, url: h.url, published_at: h.published_at, symbols: h.symbols,
    })),
  },
}];
