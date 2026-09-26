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
  "core-book-entry": {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.ai-companion-nova.dev/core-book-entry/v1",
  "title": "AI Companion Nova Core Book Entry v1",
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
  }
} as unknown as Record<string, JsonSchema>;
