import type { JsonSchema } from "./index";

export const STANDARD_SCHEMAS: Record<string, JsonSchema> = {
  "action-request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "schemaVersion",
      "tool",
      "arguments"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "string"
      },
      "tool": {
        "type": "string"
      },
      "arguments": {
        "type": "object",
        "additionalProperties": true
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "action-result": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "schemaVersion",
      "status",
      "durationMs"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "string"
      },
      "status": {
        "enum": [
          "success",
          "denied",
          "error"
        ]
      },
      "output": {},
      "error": {
        "type": "object"
      },
      "durationMs": {
        "type": "number"
      }
    }
  },
  "actor-credential": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "token"
    ],
    "additionalProperties": false,
    "properties": {
      "token": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "app-settings": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/app-settings/v10",
    "title": "AI Companion Nova App Settings v10",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "cognitiveSchedule",
      "chat",
      "context",
      "memory",
      "retrieval",
      "diagnostics",
      "ui",
      "semanticDedup",
      "memoryAgent"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "10"
      },
      "chat": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "automaticLongTermMemory",
          "responseMode"
        ],
        "properties": {
          "automaticLongTermMemory": {
            "type": "boolean"
          },
          "responseMode": {
            "type": "string",
            "enum": [
              "structured",
              "plain"
            ]
          }
        }
      },
      "context": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "availableContextTokens",
          "reservedOutputTokens",
          "safetyMarginTokens",
          "recentConversationMessages"
        ],
        "properties": {
          "availableContextTokens": {
            "type": "integer",
            "minimum": 256,
            "maximum": 32768
          },
          "reservedOutputTokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": 16384
          },
          "safetyMarginTokens": {
            "type": "integer",
            "minimum": 0,
            "maximum": 4096
          },
          "recentConversationMessages": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          }
        }
      },
      "memory": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "candidateLimit"
        ],
        "properties": {
          "candidateLimit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          }
        }
      },
      "retrieval": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "candidateLimit"
        ],
        "properties": {
          "candidateLimit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "semanticSearchEnabled": {
            "type": "boolean",
            "default": false
          },
          "semanticSimilarityThreshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "default": 0.35,
            "description": "Raw cosine similarity threshold, not a percentage."
          },
          "semanticResultLimit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 20,
            "default": 5
          }
        }
      },
      "diagnostics": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "logLevel",
          "keepRecentEntries"
        ],
        "properties": {
          "logLevel": {
            "enum": [
              "off",
              "errors",
              "normal",
              "verbose",
              "debug"
            ]
          },
          "keepRecentEntries": {
            "type": "integer",
            "minimum": 1,
            "maximum": 500
          }
        }
      },
      "ui": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "showDiagnosticsInChat"
        ],
        "properties": {
          "showDiagnosticsInChat": {
            "type": "boolean"
          }
        }
      },
      "memoryAgent": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "enabled",
          "providerPresetId",
          "model",
          "outputMode",
          "prompt",
          "promptBackup",
          "defaultPromptVersion"
        ],
        "properties": {
          "enabled": {
            "type": "boolean"
          },
          "providerPresetId": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 200
          },
          "model": {
            "type": "string",
            "maxLength": 200
          },
          "outputMode": {
            "enum": [
              "auto",
              "structured",
              "plain"
            ]
          },
          "prompt": {
            "type": "string",
            "maxLength": 12000
          },
          "promptBackup": {
            "type": [
              "string",
              "null"
            ],
            "maxLength": 12000
          },
          "defaultPromptVersion": {
            "type": "string",
            "minLength": 1,
            "maxLength": 32
          }
        }
      },
      "semanticDedup": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "enabled",
          "embeddingProviderPresetId",
          "embeddingModel",
          "candidateSimilarityThreshold",
          "candidateLimit",
          "judge"
        ],
        "properties": {
          "enabled": {
            "type": "boolean"
          },
          "embeddingProviderPresetId": {
            "type": [
              "string",
              "null"
            ],
            "minLength": 1,
            "maxLength": 200
          },
          "embeddingModel": {
            "type": "string",
            "maxLength": 200
          },
          "candidateSimilarityThreshold": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "candidateLimit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "judge": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "enabled",
              "providerPresetId",
              "model",
              "outputMode",
              "prompt",
              "promptBackup",
              "defaultPromptVersion"
            ],
            "properties": {
              "enabled": {
                "type": "boolean"
              },
              "providerPresetId": {
                "type": [
                  "string",
                  "null"
                ],
                "minLength": 1,
                "maxLength": 200
              },
              "model": {
                "type": "string",
                "maxLength": 200
              },
              "outputMode": {
                "enum": [
                  "auto",
                  "structured",
                  "plain"
                ]
              },
              "prompt": {
                "type": "string",
                "maxLength": 12000
              },
              "promptBackup": {
                "type": [
                  "string",
                  "null"
                ],
                "maxLength": 12000
              },
              "defaultPromptVersion": {
                "type": "string",
                "minLength": 1,
                "maxLength": 32
              }
            }
          }
        }
      },
      "cognitiveSchedule": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "mode",
          "defaultIntervalMs",
          "minIntervalMs",
          "maxIntervalMs",
          "maxRequestsPerHour"
        ],
        "properties": {
          "mode": {
            "enum": [
              "adaptive",
              "fixed"
            ]
          },
          "defaultIntervalMs": {
            "type": "integer",
            "minimum": 1000,
            "maximum": 3600000
          },
          "minIntervalMs": {
            "type": "integer",
            "minimum": 1000,
            "maximum": 3600000
          },
          "maxIntervalMs": {
            "type": "integer",
            "minimum": 1000,
            "maximum": 3600000
          },
          "maxRequestsPerHour": {
            "oneOf": [
              {
                "type": "integer",
                "minimum": 1,
                "maximum": 3600
              },
              {
                "type": "null"
              }
            ]
          }
        }
      }
    }
  },
  "assembled-context": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/assembled-context/v1",
    "title": "AI Companion Nova Assembled Context v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "conversationId",
      "messages",
      "includedCandidates",
      "omittedCandidates",
      "budget",
      "estimatedTokens"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "conversationId": {
        "type": "string",
        "minLength": 1
      },
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "role",
            "content"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "content": {
              "type": "string"
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "includedCandidates": {
        "type": "array",
        "items": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "$id": "https://schemas.ai-companion-nova.dev/context-candidate/v1",
          "title": "AI Companion Nova Context Candidate v1",
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "source",
            "referenceId",
            "characterId",
            "content",
            "role",
            "eligible",
            "reason",
            "estimatedTokens",
            "zone",
            "relevance",
            "activationStrength",
            "retentionPriority",
            "placementWeight",
            "recency",
            "selectionScore"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "source": {
              "enum": [
                "conversation",
                "core_book"
              ]
            },
            "referenceId": {
              "type": "string",
              "minLength": 1
            },
            "characterId": {
              "type": "string",
              "minLength": 1
            },
            "content": {
              "type": "string"
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            },
            "eligible": {
              "type": "boolean"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            },
            "estimatedTokens": {
              "type": "integer",
              "minimum": 0
            },
            "zone": {
              "enum": [
                "system",
                "character_core",
                "retrieved_core_book",
                "conversation",
                "recent_conversation"
              ]
            },
            "relevance": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "activationStrength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "retentionPriority": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "placementWeight": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "recency": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "selectionScore": {
              "type": "integer",
              "minimum": 0
            }
          }
        }
      },
      "omittedCandidates": {
        "type": "array",
        "items": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "$id": "https://schemas.ai-companion-nova.dev/context-candidate/v1",
          "title": "AI Companion Nova Context Candidate v1",
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "source",
            "referenceId",
            "characterId",
            "content",
            "role",
            "eligible",
            "reason",
            "estimatedTokens",
            "zone",
            "relevance",
            "activationStrength",
            "retentionPriority",
            "placementWeight",
            "recency",
            "selectionScore"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "source": {
              "enum": [
                "conversation",
                "core_book"
              ]
            },
            "referenceId": {
              "type": "string",
              "minLength": 1
            },
            "characterId": {
              "type": "string",
              "minLength": 1
            },
            "content": {
              "type": "string"
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            },
            "eligible": {
              "type": "boolean"
            },
            "reason": {
              "type": "string",
              "minLength": 1
            },
            "estimatedTokens": {
              "type": "integer",
              "minimum": 0
            },
            "zone": {
              "enum": [
                "system",
                "character_core",
                "retrieved_core_book",
                "conversation",
                "recent_conversation"
              ]
            },
            "relevance": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "activationStrength": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "retentionPriority": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "placementWeight": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "recency": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100
            },
            "selectionScore": {
              "type": "integer",
              "minimum": 0
            }
          }
        }
      },
      "budget": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.ai-companion-nova.dev/context-budget/v1",
        "title": "AI Companion Nova Context Budget v1",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "availableContextTokens",
          "reservedOutputTokens",
          "systemOverheadTokens",
          "safetyMarginTokens"
        ],
        "properties": {
          "availableContextTokens": {
            "type": "integer",
            "minimum": 0
          },
          "reservedOutputTokens": {
            "type": "integer",
            "minimum": 0
          },
          "systemOverheadTokens": {
            "type": "integer",
            "minimum": 0
          },
          "safetyMarginTokens": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "estimatedTokens": {
        "type": "integer",
        "minimum": 0
      }
    }
  },
  "character": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/character/v1",
    "title": "AI Companion Nova Character v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "name",
      "description",
      "createdAt",
      "updatedAt",
      "enabled"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      },
      "description": {
        "type": "string",
        "maxLength": 4096
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "enabled": {
        "type": "boolean"
      }
    }
  },
  "chat-context": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-context/v1",
    "title": "AI Companion Nova Chat Context v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "conversationId",
      "messages"
    ],
    "properties": {
      "conversationId": {
        "type": "string",
        "minLength": 1
      },
      "messages": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "role",
            "content"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "content": {
              "type": "string"
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "chat-error": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-error/v1",
    "title": "AI Companion Nova Chat Error v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "code",
      "message"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "code": {
        "enum": [
          "INVALID_REQUEST",
          "PROVIDER_NOT_FOUND",
          "PROVIDER_UNAVAILABLE",
          "PROVIDER_ERROR",
          "INVALID_RESPONSE",
          "UNSUPPORTED"
        ]
      },
      "message": {
        "type": "string",
        "minLength": 1
      },
      "requestId": {
        "type": "string",
        "minLength": 1
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "retryable": {
        "type": "boolean"
      },
      "details": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "chat-generation-options": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-generation-options/v1",
    "title": "AI Companion Nova Chat Generation Options v1",
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "temperature": {
        "type": "number",
        "minimum": 0,
        "maximum": 2
      },
      "maxTokens": {
        "type": "integer",
        "minimum": 1
      },
      "topP": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "responseFormat": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "type"
        ],
        "properties": {
          "type": {
            "enum": [
              "text",
              "json",
              "json-schema"
            ]
          },
          "schema": {
            "type": "object",
            "additionalProperties": true
          }
        },
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "const": "text"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "const": "json"
              },
              "schema": {
                "type": "object",
                "additionalProperties": true
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type",
              "schema"
            ],
            "properties": {
              "type": {
                "const": "json-schema"
              },
              "schema": {
                "type": "object",
                "additionalProperties": true
              },
              "name": {
                "type": "string",
                "minLength": 1
              },
              "strict": {
                "type": "boolean"
              }
            }
          }
        ]
      }
    }
  },
  "chat-message": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-message/v1",
    "title": "AI Companion Nova Chat Message v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "role",
      "content"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1
      },
      "role": {
        "enum": [
          "system",
          "user",
          "assistant",
          "tool"
        ]
      },
      "content": {
        "type": "string"
      },
      "toolCallId": {
        "type": "string",
        "minLength": 1
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "chat-request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-request/v1",
    "title": "AI Companion Nova Chat Request v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "requestId",
      "model",
      "context"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "requestId": {
        "type": "string",
        "minLength": 1
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "model": {
        "type": "string",
        "minLength": 1
      },
      "context": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "conversationId",
          "messages"
        ],
        "properties": {
          "conversationId": {
            "type": "string",
            "minLength": 1
          },
          "messages": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "role",
                "content"
              ],
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1
                },
                "role": {
                  "enum": [
                    "system",
                    "user",
                    "assistant",
                    "tool"
                  ]
                },
                "content": {
                  "type": "string"
                },
                "toolCallId": {
                  "type": "string",
                  "minLength": 1
                },
                "metadata": {
                  "type": "object",
                  "additionalProperties": true
                }
              }
            }
          },
          "metadata": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "generation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "temperature": {
            "type": "number",
            "minimum": 0,
            "maximum": 2
          },
          "maxTokens": {
            "type": "integer",
            "minimum": 1
          },
          "topP": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "responseFormat": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "enum": [
                  "text",
                  "json",
                  "json-schema"
                ]
              },
              "schema": {
                "type": "object",
                "additionalProperties": true
              },
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 128
              },
              "strict": {
                "type": "boolean"
              }
            }
          }
        }
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "chat-response": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/chat-response/v1",
    "title": "AI Companion Nova Chat Response v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "requestId",
      "conversationId",
      "providerId",
      "model",
      "message",
      "finishReason"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "requestId": {
        "type": "string",
        "minLength": 1
      },
      "conversationId": {
        "type": "string",
        "minLength": 1
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "model": {
        "type": "string",
        "minLength": 1
      },
      "message": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "role",
          "content"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "role": {
            "enum": [
              "system",
              "user",
              "assistant",
              "tool"
            ]
          },
          "content": {
            "type": "string"
          },
          "toolCallId": {
            "type": "string",
            "minLength": 1
          },
          "metadata": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "finishReason": {
        "enum": [
          "stop",
          "length",
          "content_filter",
          "error",
          "unknown"
        ]
      },
      "usage": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "promptTokens": {
            "type": "integer",
            "minimum": 0
          },
          "completionTokens": {
            "type": "integer",
            "minimum": 0
          },
          "totalTokens": {
            "type": "integer",
            "minimum": 0
          }
        }
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "context-budget": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/context-budget/v1",
    "title": "AI Companion Nova Context Budget v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "availableContextTokens",
      "reservedOutputTokens",
      "systemOverheadTokens",
      "safetyMarginTokens"
    ],
    "properties": {
      "availableContextTokens": {
        "type": "integer",
        "minimum": 0
      },
      "reservedOutputTokens": {
        "type": "integer",
        "minimum": 0
      },
      "systemOverheadTokens": {
        "type": "integer",
        "minimum": 0
      },
      "safetyMarginTokens": {
        "type": "integer",
        "minimum": 0
      }
    }
  },
  "context-build-request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/context-build-request/v1",
    "title": "AI Companion Nova Context Build Request v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "conversationId",
      "messages",
      "budget"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "conversationId": {
        "type": "string",
        "minLength": 1
      },
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "role",
            "content"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "content": {
              "type": "string"
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "budget": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://schemas.ai-companion-nova.dev/context-budget/v1",
        "title": "AI Companion Nova Context Budget v1",
        "type": "object",
        "additionalProperties": false,
        "required": [
          "availableContextTokens",
          "reservedOutputTokens",
          "systemOverheadTokens",
          "safetyMarginTokens"
        ],
        "properties": {
          "availableContextTokens": {
            "type": "integer",
            "minimum": 0
          },
          "reservedOutputTokens": {
            "type": "integer",
            "minimum": 0
          },
          "systemOverheadTokens": {
            "type": "integer",
            "minimum": 0
          },
          "safetyMarginTokens": {
            "type": "integer",
            "minimum": 0
          }
        }
      }
    }
  },
  "context-candidate": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/context-candidate/v1",
    "title": "AI Companion Nova Context Candidate v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "source",
      "referenceId",
      "characterId",
      "content",
      "role",
      "eligible",
      "reason",
      "estimatedTokens",
      "zone",
      "relevance",
      "activationStrength",
      "retentionPriority",
      "placementWeight",
      "recency",
      "selectionScore"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1
      },
      "source": {
        "enum": [
          "conversation",
          "core_book",
          "memory"
        ]
      },
      "referenceId": {
        "type": "string",
        "minLength": 1
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "content": {
        "type": "string"
      },
      "role": {
        "enum": [
          "system",
          "user",
          "assistant",
          "tool"
        ]
      },
      "toolCallId": {
        "type": "string",
        "minLength": 1
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      },
      "eligible": {
        "type": "boolean"
      },
      "reason": {
        "type": "string",
        "minLength": 1
      },
      "estimatedTokens": {
        "type": "integer",
        "minimum": 0
      },
      "zone": {
        "enum": [
          "system",
          "character_core",
          "retrieved_core_book",
          "retrieved_memory",
          "conversation",
          "recent_conversation"
        ]
      },
      "relevance": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "activationStrength": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "retentionPriority": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "placementWeight": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "recency": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "selectionScore": {
        "type": "integer",
        "minimum": 0
      }
    }
  },
  "context-source": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/context-source/v1",
    "title": "AI Companion Nova Context Source v1",
    "type": "string",
    "enum": [
      "conversation",
      "core_book",
      "memory"
    ]
  },
  "context-zone": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/context-zone/v1",
    "title": "AI Companion Nova Context Zone v1",
    "type": "string",
    "enum": [
      "system",
      "character_core",
      "retrieved_core_book",
      "retrieved_memory",
      "conversation",
      "recent_conversation"
    ]
  },
  "conversation-store-state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/conversation-store-state/v2",
    "title": "AI Companion Nova Conversation Store State v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "conversations",
      "activeConversationIds"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "2"
      },
      "conversations": {
        "type": "array",
        "items": {
          "$schema": "https://json-schema.org/draft/2020-12/schema",
          "$id": "https://schemas.ai-companion-nova.dev/conversation/v2",
          "title": "AI Companion Nova Conversation v2",
          "type": "object",
          "additionalProperties": false,
          "required": [
            "apiVersion",
            "schemaVersion",
            "id",
            "characterId",
            "title",
            "messages",
            "createdAt",
            "updatedAt"
          ],
          "properties": {
            "apiVersion": {
              "const": "1"
            },
            "schemaVersion": {
              "const": "2"
            },
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "characterId": {
              "type": "string",
              "minLength": 1
            },
            "title": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "messages": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "required": [
                  "role",
                  "content"
                ],
                "properties": {
                  "id": {
                    "type": "string",
                    "minLength": 1
                  },
                  "role": {
                    "enum": [
                      "system",
                      "user",
                      "assistant",
                      "tool"
                    ]
                  },
                  "content": {
                    "type": "string"
                  },
                  "toolCallId": {
                    "type": "string",
                    "minLength": 1
                  },
                  "metadata": {
                    "type": "object",
                    "additionalProperties": true
                  }
                }
              }
            },
            "createdAt": {
              "type": "string",
              "minLength": 1
            },
            "updatedAt": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      },
      "activeConversationIds": {
        "type": "object",
        "additionalProperties": {
          "type": "string",
          "minLength": 1
        }
      }
    }
  },
  "conversation": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/conversation/v2",
    "title": "AI Companion Nova Conversation v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "id",
      "characterId",
      "title",
      "messages",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "2"
      },
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "messages": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "role",
            "content"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "content": {
              "type": "string"
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "core-book-entry": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/core-book-entry/v2",
    "title": "AI Companion Nova Core Book Entry v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "characterId",
      "title",
      "content",
      "tags",
      "activation",
      "retentionPriority",
      "placementWeight",
      "mutationPolicy",
      "enabled",
      "source",
      "role",
      "metadata",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "content": {
        "type": "string"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "activation": {
        "oneOf": [
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "always"
                ]
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind",
              "keywords",
              "matchMode",
              "caseSensitive"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "keyword"
                ]
              },
              "keywords": {
                "type": "array",
                "minItems": 1,
                "items": {
                  "type": "string",
                  "minLength": 1
                }
              },
              "matchMode": {
                "enum": [
                  "any",
                  "all"
                ]
              },
              "caseSensitive": {
                "type": "boolean"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind",
              "pattern",
              "flags"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "regex"
                ]
              },
              "pattern": {
                "type": "string"
              },
              "flags": {
                "type": "string"
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "semantic"
                ]
              }
            }
          },
          {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "kind"
            ],
            "properties": {
              "kind": {
                "enum": [
                  "model_search"
                ]
              }
            }
          }
        ]
      },
      "retentionPriority": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "placementWeight": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "mutationPolicy": {
        "enum": [
          "locked",
          "suggest",
          "auto"
        ]
      },
      "enabled": {
        "type": "boolean"
      },
      "source": {
        "enum": [
          "user",
          "import",
          "system",
          "other"
        ]
      },
      "metadata": {
        "type": "object",
        "additionalProperties": true
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "role": {
        "enum": [
          "system",
          "user",
          "assistant"
        ]
      }
    }
  },
  "credential-profile-store-state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/credential-profile-store-state/v1",
    "title": "AI Companion Nova Credential Profile Store State v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "profiles"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "1"
      },
      "profiles": {
        "type": "array",
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/credential-profile/v1"
        }
      }
    }
  },
  "credential-profile": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/credential-profile/v1",
    "title": "AI Companion Nova Credential Profile v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "label",
      "providerId",
      "credentialReference",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "label": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "credentialReference": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "kind"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "minLength": 1
          },
          "provider": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "credential-reference": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "kind"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1
      },
      "kind": {
        "type": "string",
        "minLength": 1
      },
      "provider": {
        "type": "string",
        "minLength": 1
      },
      "version": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "diagnostics": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "schemaVersion",
      "timestamp",
      "runtimeStatus",
      "coreStatus",
      "modules",
      "providers",
      "recentErrors",
      "capabilities"
    ],
    "additionalProperties": false,
    "properties": {
      "schemaVersion": {
        "type": "string"
      },
      "timestamp": {
        "type": "string"
      },
      "runtimeStatus": {
        "enum": [
          "starting",
          "running",
          "degraded",
          "error",
          "stopped"
        ]
      },
      "coreStatus": {
        "enum": [
          "starting",
          "running",
          "degraded",
          "error",
          "stopped"
        ]
      },
      "modules": {
        "type": "array"
      },
      "providers": {
        "type": "array"
      },
      "recentErrors": {
        "type": "array"
      },
      "capabilities": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "event-envelope": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "type",
      "timestamp",
      "source",
      "schemaVersion",
      "payload"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "type": {
        "type": "string"
      },
      "timestamp": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "string"
      },
      "payload": {}
    }
  },
  "health-status": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "status"
    ],
    "additionalProperties": false,
    "properties": {
      "status": {
        "enum": [
          "healthy",
          "degraded",
          "unavailable",
          "error"
        ]
      },
      "message": {
        "type": "string"
      },
      "capabilities": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "lastSuccessfulOperation": {
        "type": "string"
      },
      "diagnostics": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "json-rpc-message": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "description": "Validated at runtime by the JSON-RPC boundary. Request, response and notification share the jsonrpc marker."
  },
  "memory-agent-decision": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-agent-decision/v1",
    "title": "AI Companion Nova Memory Agent Decision v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "decision",
      "content"
    ],
    "properties": {
      "decision": {
        "enum": [
          "remember",
          "no_memory"
        ]
      },
      "content": {
        "type": "string",
        "maxLength": 32768
      }
    }
  },
  "memory-candidate": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-candidate/v1",
    "title": "AI Companion Nova Memory Candidate v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "type",
      "content",
      "tags",
      "importance",
      "confidence",
      "source",
      "sourceReference",
      "mutationPolicy"
    ],
    "properties": {
      "type": {
        "enum": [
          "fact",
          "preference",
          "relationship",
          "event",
          "experience",
          "goal",
          "instruction",
          "observation"
        ]
      },
      "content": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000
      },
      "tags": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "importance": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "confidence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "source": {
        "const": "conversation"
      },
      "sourceReference": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "mutationPolicy": {
        "const": "auto"
      }
    }
  },
  "memory-extraction-request": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-extraction-request/v1",
    "title": "AI Companion Nova Memory Extraction Request v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "conversationId",
      "turnId",
      "model",
      "userMessage",
      "assistantMessage",
      "contextMessages"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "1"
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "conversationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "turnId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "providerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "providerPresetId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "userMessage": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "role",
          "content"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "role": {
            "enum": [
              "system",
              "user",
              "assistant",
              "tool"
            ]
          },
          "content": {
            "type": "string"
          },
          "toolCallId": {
            "type": "string",
            "minLength": 1
          },
          "metadata": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "assistantMessage": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "role",
          "content"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "role": {
            "enum": [
              "system",
              "user",
              "assistant",
              "tool"
            ]
          },
          "content": {
            "type": "string"
          },
          "toolCallId": {
            "type": "string",
            "minLength": 1
          },
          "metadata": {
            "type": "object",
            "additionalProperties": true
          }
        }
      },
      "contextMessages": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "role",
            "content"
          ],
          "properties": {
            "id": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "role": {
              "enum": [
                "system",
                "user",
                "assistant",
                "tool"
              ]
            },
            "content": {
              "type": "string"
            },
            "toolCallId": {
              "type": "string",
              "minLength": 1
            },
            "metadata": {
              "type": "object",
              "additionalProperties": true
            }
          }
        }
      }
    }
  },
  "memory-extraction-result": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-extraction-result/v1",
    "title": "AI Companion Nova Memory Extraction Result v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "memories"
    ],
    "properties": {
      "memories": {
        "type": "array",
        "maxItems": 12,
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/memory-candidate/v1"
        }
      }
    }
  },
  "memory-item": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-item/v3",
    "title": "AI Companion Nova Dynamic Memory Item v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "characterId",
      "originConversationId",
      "type",
      "content",
      "tags",
      "importance",
      "confidence",
      "createdAt",
      "updatedAt",
      "validFrom",
      "validUntil",
      "source",
      "sourceReference",
      "mutationPolicy",
      "status",
      "archiveReason",
      "metadata"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "type": {
        "enum": [
          "fact",
          "preference",
          "relationship",
          "event",
          "experience",
          "goal",
          "instruction",
          "observation"
        ]
      },
      "content": {
        "type": "string",
        "minLength": 1,
        "maxLength": 32768
      },
      "tags": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "importance": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "confidence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "validFrom": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1
      },
      "validUntil": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1
      },
      "source": {
        "enum": [
          "user",
          "conversation",
          "file",
          "tool",
          "model",
          "system"
        ]
      },
      "sourceReference": {
        "type": [
          "string",
          "null"
        ],
        "maxLength": 500
      },
      "mutationPolicy": {
        "enum": [
          "locked",
          "suggest",
          "auto"
        ]
      },
      "status": {
        "enum": [
          "active",
          "superseded",
          "archived"
        ]
      },
      "archiveReason": {
        "type": [
          "string",
          "null"
        ],
        "enum": [
          "manual",
          "duplicate",
          "superseded",
          "other",
          null
        ]
      },
      "supersededBy": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 200
      },
      "metadata": {
        "type": "object",
        "maxProperties": 64,
        "additionalProperties": true
      },
      "originConversationId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "memory-judge-decision": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-judge-decision/v1",
    "title": "AI Companion Nova Memory Judge Decision v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "archive"
    ],
    "properties": {
      "archive": {
        "type": "array",
        "maxItems": 100,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "pattern": "^(?:NEW|[1-9][0-9]*)$"
        }
      }
    }
  },
  "memory-search-query": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-search-query/v3",
    "title": "AI Companion Nova Dynamic Memory Search Query v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "characterId",
      "query"
    ],
    "properties": {
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "query": {
        "type": "string",
        "maxLength": 256
      },
      "types": {
        "type": "array",
        "maxItems": 8,
        "items": {
          "enum": [
            "fact",
            "preference",
            "relationship",
            "event",
            "experience",
            "goal",
            "instruction",
            "observation"
          ]
        }
      },
      "tags": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        }
      },
      "status": {
        "enum": [
          "active",
          "superseded",
          "archived"
        ]
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "originConversationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "memory-semantic-index": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-semantic-index/v1",
    "title": "AI Companion Nova Derived Memory Semantic Index v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "records"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "1"
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "records": {
        "type": "array",
        "maxItems": 10000,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "memoryId",
            "characterId",
            "contentHash",
            "embeddingProviderId",
            "embeddingModel",
            "dimensions",
            "vector",
            "updatedAt"
          ],
          "properties": {
            "memoryId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "characterId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "contentHash": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            },
            "embeddingProviderId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "embeddingModel": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "dimensions": {
              "type": "integer",
              "minimum": 1,
              "maximum": 10000
            },
            "vector": {
              "type": "array",
              "minItems": 1,
              "maxItems": 10000,
              "items": {
                "type": "number"
              }
            },
            "updatedAt": {
              "type": "string",
              "minLength": 1
            }
          }
        }
      }
    }
  },
  "memory-store-state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/memory-store-state/v3",
    "title": "AI Companion Nova Dynamic Memory Store State v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "items"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "3"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/memory-item/v3"
        }
      }
    }
  },
  "model-profile-store-state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/model-profile-store-state/v2",
    "title": "AI Companion Nova Model Profile Store State v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "profiles"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "2"
      },
      "profiles": {
        "type": "array",
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/model-profile/v2"
        }
      }
    }
  },
  "model-profile": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/model-profile/v2",
    "title": "AI Companion Nova Character Model Profile v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "id",
      "characterId",
      "generation",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "2"
      },
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "characterId": {
        "type": "string",
        "minLength": 1
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "model": {
        "type": "string",
        "minLength": 1
      },
      "generation": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "temperature": {
            "type": "number",
            "minimum": 0,
            "maximum": 2
          },
          "maxTokens": {
            "type": "integer",
            "minimum": 1
          },
          "topP": {
            "type": "number",
            "minimum": 0,
            "maximum": 1
          },
          "responseFormat": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "type"
            ],
            "properties": {
              "type": {
                "enum": [
                  "text",
                  "json"
                ]
              },
              "schema": {
                "type": "object",
                "additionalProperties": true
              }
            }
          }
        }
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "providerPresetId": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "module-manifest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "name",
      "version",
      "apiVersion",
      "schemaVersion",
      "type",
      "runtime",
      "optional",
      "capabilities"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "apiVersion": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "string"
      },
      "type": {
        "enum": [
          "service",
          "adapter",
          "worker",
          "ui"
        ]
      },
      "runtime": {
        "enum": [
          "typescript",
          "rust"
        ]
      },
      "optional": {
        "type": "boolean"
      },
      "capabilities": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "permission": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "id",
      "schemaVersion",
      "subject",
      "resourceType",
      "action",
      "effect"
    ],
    "additionalProperties": false,
    "properties": {
      "id": {
        "type": "string"
      },
      "schemaVersion": {
        "type": "string"
      },
      "subject": {
        "type": "string"
      },
      "resourceType": {
        "enum": [
          "domain",
          "filesystem",
          "application",
          "resource"
        ]
      },
      "action": {
        "type": "string"
      },
      "effect": {
        "enum": [
          "allow",
          "deny"
        ]
      },
      "scope": {
        "type": "object",
        "additionalProperties": true
      }
    }
  },
  "provider-capability": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "additionalProperties": {
      "type": "boolean"
    }
  },
  "provider-configuration": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/provider-configuration/v1",
    "title": "AI Companion Nova Provider Configuration v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "providerId",
      "enabled",
      "baseUrl",
      "model",
      "credentialReference"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "enabled": {
        "type": "boolean"
      },
      "baseUrl": {
        "type": "string",
        "minLength": 1
      },
      "model": {
        "type": "string",
        "minLength": 1
      },
      "credentialReference": {
        "type": [
          "object",
          "null"
        ],
        "additionalProperties": false,
        "required": [
          "id",
          "kind"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1
          },
          "kind": {
            "type": "string",
            "minLength": 1
          },
          "provider": {
            "type": "string",
            "minLength": 1
          },
          "version": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "timeoutMs": {
        "type": "number",
        "minimum": 0.000001
      },
      "numCtx": {
        "type": "integer",
        "minimum": 1
      },
      "numPredict": {
        "type": "integer",
        "minimum": 1
      },
      "keepAlive": {
        "type": [
          "string",
          "number"
        ],
        "minLength": 1,
        "minimum": -1
      },
      "temperature": {
        "type": "number",
        "minimum": 0,
        "maximum": 2
      },
      "topP": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      }
    }
  },
  "provider-connection-test-result": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/provider-connection-test-result/v1",
    "title": "AI Companion Nova Provider Connection Test Result v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "status",
      "providerId"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "status": {
        "enum": [
          "connected",
          "authentication_failed",
          "configuration_error",
          "network_error",
          "timeout",
          "provider_error"
        ]
      },
      "providerId": {
        "type": "string",
        "minLength": 1
      },
      "message": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "provider-preset-source": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/provider-preset-source/v2",
    "title": "AI Companion Nova Provider Preset Source v2",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "name",
      "providerId",
      "baseUrl",
      "model",
      "credentialReference",
      "enabled",
      "health",
      "failureCount",
      "cooldownUntil",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "providerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "baseUrl": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "model": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "credentialReference": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "$ref": "https://schemas.ai-companion-nova.dev/credential-reference/v1"
          }
        ]
      },
      "enabled": {
        "type": "boolean"
      },
      "health": {
        "enum": [
          "healthy",
          "cooldown",
          "unavailable"
        ]
      },
      "failureCount": {
        "type": "integer",
        "minimum": 0
      },
      "cooldownUntil": {
        "type": [
          "string",
          "null"
        ]
      },
      "timeoutMs": {
        "type": "number",
        "minimum": 0.000001
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "numCtx": {
        "type": "integer",
        "minimum": 1
      },
      "numPredict": {
        "type": "integer",
        "minimum": 1
      },
      "keepAlive": {
        "type": [
          "string",
          "number"
        ],
        "minLength": 1,
        "minimum": -1
      },
      "temperature": {
        "type": "number",
        "minimum": 0,
        "maximum": 2
      },
      "topP": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      }
    }
  },
  "provider-preset-store-state": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/provider-preset-store-state/v3",
    "title": "AI Companion Nova Provider Preset Store State v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "presets",
      "activePresetId"
    ],
    "properties": {
      "apiVersion": {
        "const": "1"
      },
      "schemaVersion": {
        "const": "3"
      },
      "presets": {
        "type": "array",
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/provider-preset/v3"
        }
      },
      "activePresetId": {
        "type": [
          "string",
          "null"
        ]
      }
    }
  },
  "provider-preset": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/provider-preset/v3",
    "title": "AI Companion Nova Provider Preset v3",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "name",
      "type",
      "sources",
      "activeSourceId",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "sources": {
        "type": "array",
        "items": {
          "$ref": "https://schemas.ai-companion-nova.dev/provider-preset-source/v2"
        }
      },
      "activeSourceId": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1
      },
      "createdAt": {
        "type": "string",
        "minLength": 1
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "type": {
        "enum": [
          "pool",
          "single"
        ]
      },
      "providerId": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "enum": [
              "openai-compatible",
              "gemini",
              "ollama"
            ]
          }
        ]
      },
      "baseUrl": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 2000,
        "format": "uri"
      },
      "model": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "maxLength": 200
      },
      "credentialReference": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "$ref": "https://schemas.ai-companion-nova.dev/credential-reference/v1"
          }
        ]
      },
      "enabled": {
        "type": [
          "boolean",
          "null"
        ]
      },
      "timeoutMs": {
        "type": [
          "number",
          "null"
        ],
        "exclusiveMinimum": 0
      },
      "numCtx": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "numPredict": {
        "type": [
          "integer",
          "null"
        ],
        "minimum": 1
      },
      "keepAlive": {
        "type": [
          "string",
          "number",
          "null"
        ],
        "minLength": 1,
        "minimum": -1
      },
      "temperature": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0,
        "maximum": 2
      },
      "topP": {
        "type": [
          "number",
          "null"
        ],
        "minimum": 0,
        "maximum": 1
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "type": {
              "const": "pool"
            }
          },
          "required": [
            "type"
          ]
        },
        "then": {
          "properties": {
            "sources": {
              "minItems": 1
            }
          },
          "not": {
            "anyOf": [
              {
                "required": [
                  "providerId"
                ],
                "properties": {
                  "providerId": {
                    "type": "string"
                  }
                }
              },
              {
                "required": [
                  "baseUrl"
                ],
                "properties": {
                  "baseUrl": {
                    "type": "string"
                  }
                }
              },
              {
                "required": [
                  "model"
                ],
                "properties": {
                  "model": {
                    "type": "string"
                  }
                }
              },
              {
                "required": [
                  "credentialReference"
                ],
                "properties": {
                  "credentialReference": {
                    "$ref": "https://schemas.ai-companion-nova.dev/credential-reference/v1"
                  }
                }
              },
              {
                "required": [
                  "enabled"
                ],
                "properties": {
                  "enabled": {
                    "type": "boolean"
                  }
                }
              },
              {
                "required": [
                  "timeoutMs"
                ],
                "properties": {
                  "timeoutMs": {
                    "type": "number"
                  }
                }
              },
              {
                "required": [
                  "numCtx"
                ],
                "properties": {
                  "numCtx": {
                    "type": "integer"
                  }
                }
              },
              {
                "required": [
                  "numPredict"
                ],
                "properties": {
                  "numPredict": {
                    "type": "integer"
                  }
                }
              },
              {
                "required": [
                  "keepAlive"
                ],
                "properties": {
                  "keepAlive": {
                    "type": [
                      "string",
                      "number"
                    ]
                  }
                }
              },
              {
                "required": [
                  "temperature"
                ],
                "properties": {
                  "temperature": {
                    "type": "number"
                  }
                }
              },
              {
                "required": [
                  "topP"
                ],
                "properties": {
                  "topP": {
                    "type": "number"
                  }
                }
              }
            ]
          }
        }
      },
      {
        "if": {
          "properties": {
            "type": {
              "const": "single"
            }
          },
          "required": [
            "type"
          ]
        },
        "then": {
          "required": [
            "providerId",
            "baseUrl",
            "model",
            "credentialReference",
            "enabled"
          ],
          "properties": {
            "sources": {
              "maxItems": 0
            },
            "activeSourceId": {
              "const": null
            },
            "providerId": {
              "enum": [
                "openai-compatible",
                "gemini",
                "ollama"
              ]
            },
            "baseUrl": {
              "type": "string",
              "minLength": 1,
              "maxLength": 2000,
              "format": "uri"
            },
            "model": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200
            },
            "credentialReference": {
              "anyOf": [
                {
                  "type": "null"
                },
                {
                  "$ref": "https://schemas.ai-companion-nova.dev/credential-reference/v1"
                }
              ]
            },
            "enabled": {
              "type": "boolean"
            },
            "timeoutMs": {
              "type": "number",
              "exclusiveMinimum": 0
            },
            "numCtx": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1
            },
            "numPredict": {
              "type": [
                "integer",
                "null"
              ],
              "minimum": 1
            },
            "keepAlive": {
              "type": [
                "string",
                "number",
                "null"
              ],
              "minLength": 1,
              "minimum": -1
            },
            "temperature": {
              "type": [
                "number",
                "null"
              ],
              "minimum": 0,
              "maximum": 2
            },
            "topP": {
              "type": [
                "number",
                "null"
              ],
              "minimum": 0,
              "maximum": 1
            }
          }
        }
      }
    ],
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "name",
          "type",
          "sources",
          "activeSourceId",
          "createdAt",
          "updatedAt"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "sources": {
            "type": "array",
            "items": {
              "$ref": "https://schemas.ai-companion-nova.dev/provider-preset-source/v2"
            },
            "minItems": 1
          },
          "activeSourceId": {
            "type": [
              "string",
              "null"
            ],
            "minLength": 1
          },
          "createdAt": {
            "type": "string",
            "minLength": 1
          },
          "updatedAt": {
            "type": "string",
            "minLength": 1
          },
          "type": {
            "const": "pool"
          },
          "providerId": {
            "type": "null"
          },
          "baseUrl": {
            "type": "null"
          },
          "model": {
            "type": "null"
          },
          "credentialReference": {
            "type": "null"
          },
          "enabled": {
            "type": "null"
          },
          "timeoutMs": {
            "type": "null"
          },
          "numCtx": {
            "type": "null"
          },
          "numPredict": {
            "type": "null"
          },
          "keepAlive": {
            "type": "null"
          },
          "temperature": {
            "type": "null"
          },
          "topP": {
            "type": "null"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "name",
          "type",
          "sources",
          "activeSourceId",
          "providerId",
          "baseUrl",
          "model",
          "credentialReference",
          "enabled",
          "createdAt",
          "updatedAt"
        ],
        "properties": {
          "id": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "sources": {
            "type": "array",
            "maxItems": 0
          },
          "activeSourceId": {
            "const": null
          },
          "createdAt": {
            "type": "string",
            "minLength": 1
          },
          "updatedAt": {
            "type": "string",
            "minLength": 1
          },
          "type": {
            "const": "single"
          },
          "providerId": {
            "enum": [
              "openai-compatible",
              "gemini",
              "ollama"
            ]
          },
          "baseUrl": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "format": "uri"
          },
          "model": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200
          },
          "credentialReference": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "$ref": "https://schemas.ai-companion-nova.dev/credential-reference/v1"
              }
            ]
          },
          "enabled": {
            "type": "boolean"
          },
          "timeoutMs": {
            "type": "number",
            "exclusiveMinimum": 0
          },
          "numCtx": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          },
          "numPredict": {
            "type": [
              "integer",
              "null"
            ],
            "minimum": 1
          },
          "keepAlive": {
            "type": [
              "string",
              "number",
              "null"
            ],
            "minLength": 1,
            "minimum": -1
          },
          "temperature": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 2
          },
          "topP": {
            "type": [
              "number",
              "null"
            ],
            "minimum": 0,
            "maximum": 1
          }
        }
      }
    ]
  },
  "retrieval-candidate": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-candidate/v1",
    "title": "AI Companion Nova Retrieval Candidate v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "source",
      "sourceId",
      "characterId",
      "score",
      "matchedText",
      "matches"
    ],
    "properties": {
      "source": {
        "enum": [
          "core_book",
          "memory"
        ]
      },
      "sourceId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "score": {
        "type": "number"
      },
      "matchedText": {
        "type": "string"
      },
      "matches": {
        "type": "array",
        "maxItems": 3,
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "field",
            "text"
          ],
          "properties": {
            "field": {
              "enum": [
                "title",
                "content",
                "tags"
              ]
            },
            "text": {
              "type": "string"
            }
          }
        }
      },
      "metadata": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "updatedAt"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "status": {
            "type": "string"
          },
          "type": {
            "type": "string"
          },
          "updatedAt": {
            "type": "string",
            "minLength": 1
          }
        }
      },
      "conversationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "retrieval-index-document": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-index-document/v1",
    "title": "AI Companion Nova Retrieval Index Document v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "source",
      "sourceId",
      "title",
      "content",
      "tags",
      "updatedAt"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "source": {
        "enum": [
          "core_book",
          "memory"
        ]
      },
      "sourceId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "title": {
        "type": "string",
        "maxLength": 200
      },
      "content": {
        "type": "string"
      },
      "tags": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "maxItems": 32
      },
      "status": {
        "type": "string",
        "maxLength": 32
      },
      "type": {
        "type": "string",
        "maxLength": 32
      },
      "updatedAt": {
        "type": "string",
        "minLength": 1
      },
      "conversationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "retrieval-match": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-match/v1",
    "title": "AI Companion Nova Retrieval Match v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "field",
      "text"
    ],
    "properties": {
      "field": {
        "enum": [
          "title",
          "content",
          "tags"
        ]
      },
      "text": {
        "type": "string"
      }
    }
  },
  "retrieval-query": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-query/v1",
    "title": "AI Companion Nova Retrieval Query v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "query"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "query": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "sources": {
        "type": "array",
        "items": {
          "enum": [
            "core_book",
            "memory"
          ]
        },
        "uniqueItems": true,
        "minItems": 1,
        "maxItems": 2
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "filters": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "status": {
            "type": "string",
            "minLength": 1,
            "maxLength": 32
          },
          "type": {
            "type": "string",
            "minLength": 1,
            "maxLength": 32
          },
          "tags": {
            "type": "array",
            "items": {
              "type": "string",
              "minLength": 1,
              "maxLength": 64
            },
            "uniqueItems": true,
            "maxItems": 32
          }
        }
      },
      "conversationId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    }
  },
  "retrieval-result": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-result/v1",
    "title": "AI Companion Nova Retrieval Result v1",
    "type": "object",
    "additionalProperties": false,
    "required": [
      "apiVersion",
      "schemaVersion",
      "characterId",
      "query",
      "candidates",
      "degraded"
    ],
    "properties": {
      "apiVersion": {
        "enum": [
          "1"
        ]
      },
      "schemaVersion": {
        "enum": [
          "1"
        ]
      },
      "characterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "query": {
        "type": "string"
      },
      "candidates": {
        "type": "array",
        "items": {
          "type": "object"
        }
      },
      "degraded": {
        "type": "boolean"
      },
      "error": {
        "type": "string",
        "minLength": 1
      }
    }
  },
  "retrieval-source": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://schemas.ai-companion-nova.dev/retrieval-source/v1",
    "title": "AI Companion Nova Retrieval Source v1",
    "type": "string",
    "enum": [
      "core_book",
      "memory"
    ]
  }
} as unknown as Record<string, JsonSchema>;
