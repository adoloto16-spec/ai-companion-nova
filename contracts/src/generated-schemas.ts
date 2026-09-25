import type {JsonSchema} from "./index";

export const STANDARD_SCHEMAS:Record<string,JsonSchema>={
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
        "type": "string"
      },
      "kind": {
        "type": "string"
      },
      "provider": {
        "type": "string"
      },
      "version": {
        "type": "string"
      }
    }
  },
  "json-rpc-message": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "description": "Validated at runtime by the JSON-RPC boundary. Request, response and notification share the jsonrpc marker."
  }
} as unknown as Record<string,JsonSchema>;
