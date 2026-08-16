export function createInboxOnlyAgent(store) {
  return Object.freeze({
    async chat(request) {
      await store.ingest(request);
      return Object.freeze({});
    },
  });
}
