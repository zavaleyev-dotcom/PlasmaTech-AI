# Integration boundaries

Crossref is a working public server-side bibliographic adapter. OpenAlex is a
prepared, inactive adapter. Other integrations contain TypeScript contracts only.
No authentication, databases, paid AI services or Google Drive connections exist.

Future implementations of these ports must run on the server, use a
`server-only` boundary, and receive secrets from server environment variables.
Do not re-export concrete adapters through client-facing barrels. Before enabling
an adapter, implement validation, access controls, timeouts and error handling.

- `openai`: language model gateway.
- `mcp`: tool-call transport boundary.
- `google-drive`: knowledge document source.
- `scientific-databases`: searchable scientific source.
- `postgresql`, `supabase`: alternatives implementing the database repository.

- `crossref`: public REST search and DOI lookup; no API key.
- `openalex`: inactive ScientificSourceProvider; optional OPENALEX_API_KEY reserved.
