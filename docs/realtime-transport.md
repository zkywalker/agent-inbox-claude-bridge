# Realtime transport

Outgoing messages wake the sender immediately. Streaming text is coalesced into a bounded durable journal; first output and completion commit immediately. Clean shutdown compacts snapshots for older Bridge versions. Message delta PATCH is negotiated with the gateway and retains stable identity after lost receipts or gateway downgrade. File transfers use a 64 KiB first block, bounded 256 KiB following blocks, and release host readers on cancellation. Existing signed updates and host service ownership checks remain active.
