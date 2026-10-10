# Semantic search

Nova's optional semantic retrieval uses the configured Embedding Provider Preset and Embedding Model from the existing Semantic Memory Deduplication settings. Automatic context injection is separately controlled by Retrieval → Automatic Semantic Search.

- Initial cosine similarity threshold: 0.35. This is a raw cosine value, not a percentage. It is a starting default, not a corpus-calibrated quality guarantee; tune it for the selected model and corpus.
- Result limit defaults to 5 and is bounded to 20. The Context Engine may omit hits that do not fit its token budget.
- Every saved user message, assistant NOVA_TURN, Core Book entry and Character Memory record is one canonical document. Long input is chunked only for embedding; the complete source remains retrievable.
- The embedding contract exposes batching and vector dimensions but no tokenizer or universal token limit. Inputs are conservatively chunked at 2,400 Unicode code points with 120 code points of overlap. This is a safety heuristic, not a token count; failed/oversized batches are split and retried a bounded number of times.
- The existing per-character persistent semantic-index store is reused. Semantic records have a separate ID namespace to preserve records owned by Memory Deduplication. Content hash + provider ID + model identify reusable vectors.
- Background progress is exposed by FoundationRuntime.getSemanticSearchStatus() and diagnostics code SEMANTIC_SEARCH_INDEX_PROGRESS. FoundationRuntime.rebuildSemanticSearchIndex() requests an idempotent re-scan. Diagnostics contain counts, source IDs, model identity and error codes, not full private content or keys.
- Semantic retrieval supplements Core Book activation, MemoryRetriever and SQLite/FTS. It is scoped to one character and indexes enabled Core Book entries, active/valid Memory, and saved user/assistant messages across all that character's conversations including older messages outside the current context window.
- Read-only MEMORY_SEARCH uses the existing Tool Registry, action broker and NOVA_TURN tool-result loop.
