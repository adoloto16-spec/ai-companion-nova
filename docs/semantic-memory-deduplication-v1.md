# Semantic Memory Deduplication v1

Semantic deduplication is an optional post-persistence path. `MemoryBroker` remains the canonical memory authority.

    MemoryBroker.create
      -> derived embedding cache
      -> same-character active candidate scan
      -> cosine similarity OR token-set containment
      -> shared candidate limit with containment priority
      -> Memory Judge (structured/plain)
      -> deterministic ID validation
      -> MemoryBroker.archive

Embeddings remain candidate discovery only. Normal Chat memory retrieval remains lexical.

Deterministic containment normalizes text with NFKC, lowercases it, tokenizes Unicode letters/numbers, removes duplicate tokens, and requires at least four unique meaningful tokens in the subset. Word order and punctuation do not affect the set comparison. Containment only adds candidates; it never archives memory by itself.

The Judge receives only the canonical NEW MEMORY and deterministic CANDIDATES:

    NEW MEMORY
    id: <real id>
    content: <text>

    CANDIDATES
    1. id: <real id>
       content: <text>

The Judge returns only `{"archiveIds":["real-id"]}` / `{"archiveIds":[]}` in structured mode, or `NO_ARCHIVE` / one real ID per line in plain mode. Relations, summaries, replacement text, explanations, ranking metadata, and other decision fields are not part of the protocol.

All returned IDs are validated against the exact NEW/CANDIDATE IDs supplied to the Judge. An attempt to archive every supplied record is blocked before mutation. Otherwise Core archives exactly the returned active IDs through `MemoryBroker`; records are never physically deleted.

Explicit content containment preserves the more informative record by archiving its smaller content subset. Equal-information ties are valid: the single ID chosen by the Judge is used, leaving the other record active.
