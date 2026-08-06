# Runtime v1 compatibility policy

`@pi-forge/runtime-contracts` follows Semantic Versioning. The `protocolVersion` field is the wire-protocol major and is `1` for every compatible v1 release.

## Compatible changes within v1

- adding optional capabilities;
- adding optional fields that v1 validators explicitly allow;
- adding SDK helpers that do not change wire data;
- clarifying validation limits without accepting previously invalid privileged input.

Unknown optional capabilities are ignored. Required capabilities are fail-closed: a connection is rejected when either peer does not advertise support.

## Changes that require protocol v2

- removing or renaming an envelope kind, Runtime method, required field, event type, or error code;
- changing the meaning or type of an existing field;
- changing ordering, delivery, checkpoint, or offset guarantees;
- making an optional capability mandatory for existing v1 methods.

Every inbound envelope must pass the exported runtime validators. Unknown methods, incompatible majors, malformed payloads, and missing required capabilities are rejected rather than coerced. Desktop-only host RPC—including credentials, MCP, browser access, and filesystem services—is outside this public protocol and is not a compatibility promise.

Deprecations remain available for at least one v1 minor release before a protocol-major removal. Security fixes may tighten rejection of malformed or unsafe input without a major bump.
