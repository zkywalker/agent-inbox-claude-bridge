# Reliable transport in 0.1.5

Control and runtime-management inboxes use independent 20-second long polls. Historical session reports only upload changes; instance heartbeats and configuration maintenance no longer wait for history uploads. Stop and approval handling remain responsive while reports are slow.

Message polling now uses the shared recovery key and complete response validation while retaining Claude instance binding. Lost or cancelled responses retry the same batch identity; shutdown cancels pending reads and rejects late input. Message network failures back off from two to thirty seconds, and authentication failures wait sixty seconds. Native execution is never automatically replayed.

The durable outbox isolates permanently rejected output, retries transient failures, and fairly serves up to four conversations. It removes redundant PATCH requests after successful creation and reconciles lost create responses. Oversized text is explicitly bounded on the wire while retaining the original local record. Local notification correlation stays local.

SDK version, native executable, permission defaults, model selection, signing identity and existing session mappings are unchanged. SOURCE.json identifies the upstream files and adaptations. All 26 isolated release tests, typecheck and build pass; real host deployment is recorded separately in the gateway project.
