# Semantic Memory Deduplication v1

Semantic deduplication is an optional post-persistence path. `MemoryBroker` remains the canonical memory authority.

    MemoryBroker.create
      -> derived embedding cache
      -> same-character active candidate scan
      -> deterministic top-K similarity filter
      -> Memory Judge (structured/plain through Agent Output)
      -> deterministic validation and aggregation
      -> MemoryBroker.archive

Embeddings are used only for candidate discovery in this release. Normal Chat memory retrieval remains lexical.

The derived index stores memory id, character id, deterministic content hash, embedding provider/model, dimensions, vector, and update time. It can be rebuilt from canonical Memory records and is invalidated by provider/model/dimension/content changes.

The Judge receives only the newly persisted Memory and deterministic candidate records. Candidate ids are authoritative input data; an id absent from the candidate list is invalid and produces no mutation.

Automatic semantic deduplication can only archive records. Permanent deletion and restore remain explicit user-controlled MemoryBroker operations.
