# Integration boundaries

Only TypeScript contracts are present. No connections, SDKs, credentials,
authentication, network requests, databases or paid services are configured.

Future implementations of these ports must run on the server, use a
`server-only` boundary, and receive secrets from server environment variables.
Do not re-export concrete adapters through client-facing barrels. Before enabling
an adapter, implement validation, access controls, timeouts and error handling.

- `openai`: language model gateway.
- `mcp`: tool-call transport boundary.
- `google-drive`: knowledge document source.
- `scientific-databases`: searchable scientific source.
- `postgresql`, `supabase`: alternatives implementing the database repository.
