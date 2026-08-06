# `@pi-forge/runtime-contracts`

Internal prerelease **v0** wire contracts shared by Pi Forge runtime hosts and workers.

The package contains versioned Runtime RPC envelopes, capability negotiation, runtime validators, and the Session/Event data transferred over that boundary. It intentionally has no Electron, React, credential, browser, persistence, SDK, Agent-template, or scheduling implementation.

`0.0.0` and protocol version `0` are not stable-v1 promises. Until a v1 compatibility policy is published, consumers must negotiate the exact protocol version and required capabilities and reject unknown or malformed wire data.
