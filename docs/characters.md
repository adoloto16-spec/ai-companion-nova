# Character System V1

## Character

The canonical `Character` model is a stable identity/container for one companion scope. V1 stores only lifecycle metadata:

- `id`
- `name`
- `description`
- `createdAt`
- `updatedAt`
- `enabled`

It does not implement personality, emotions, lorebook, memory, prompts, tools, credentials or provider-specific state.

## Character scope

`characterId` is the stable identity. Names are mutable metadata and are never used as identity or array indexes.

Future subsystems are scoped to this id rather than placed in global state:

```text
Character
├── Core Book
├── Dynamic Memory
├── Attached Knowledge
├── Conversations
├── Library
├── Model Profile
└── Permissions
```

Those subsystems are not implemented in V1.

## Active Character

Each runtime/session has exactly one active Character. Switching persists `activeCharacterId` and emits `ActiveCharacterChanged`.

Deleting the active Character switches to another enabled Character when one exists. Deleting the last Character recreates deterministic Nova:

- id: `character.nova.default.v1`
- name: `Nova`
- enabled: `true`

The manager does not allow the active Character to become disabled.

## Storage

The existing Tauri application-config persistence boundary is reused. Character metadata is stored in `characters-v1.json` through the provider-neutral `CharacterStore` abstraction and Host IPC implementation.

No API keys, credentials or secrets are stored with Characters.

## Chat integration

`ConversationSession` now carries `characterId`. The desktop UI creates a new non-persistent session when the active Character changes.

AiRuntime, ChatProvider, provider configuration and credential architecture are unchanged. No personality or memory content is added to ChatRequest.

## Events

The existing EventBus carries:

- `CharacterCreated`
- `CharacterUpdated`
- `CharacterDeleted`
- `ActiveCharacterChanged`

All event payloads include the relevant `characterId`.

## Future attachments

Later PRs may attach Core Book, Dynamic Memory, Knowledge, Conversation state, Library/Workspace, Model Profile and Permission Profile through the Character scope. V1 establishes only the identity, lifecycle, persistence and scope boundary.
