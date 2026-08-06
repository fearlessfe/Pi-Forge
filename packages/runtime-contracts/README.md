# `@pi-forge/runtime-contracts`

Stable **v1** wire contracts shared by Pi Forge runtime clients, hosts, SDKs, and desktop workers.

The package contains Runtime RPC envelopes, capability negotiation, runtime validators, durable Event/Session types, and exhaustive Runtime method metadata. It intentionally has no Electron, React, credentials, browser implementation, or privileged host services.

Protocol `1` is the stable major. Consumers must validate every envelope, negotiate required capabilities, ignore unknown optional capabilities, and reject incompatible majors or malformed data. See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for the public compatibility policy.
