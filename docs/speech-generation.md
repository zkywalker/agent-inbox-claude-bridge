# Generated speech

This release exposes `agent_inbox_generate_speech` (`capabilities`, `generate`, `get`) and `agent_inbox_send_attachment`. The gateway owns provider credentials and stable voice aliases. Generation creates an attachment; explicit delivery binds it to the current conversation. Reuse request/message IDs after uncertain results. Requires the compatible gateway and per-agent speech authorization. Existing Codex threads keep their registered tools; start a new Inbox topic to discover the added tools.
