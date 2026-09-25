# Private wake-word recordings

This opt-in feature stores short wake-word examples on the Home Assistant host for human review. It never starts model training or installs a model. Capture defaults to **off** for each satellite.

Audio and JSON sidecars live below `hass.config.path("voice_satellite", "recordings")`, grouped by a hash of the satellite's stable configuration entry ID. They are not exposed through `/local`, `www`, the integration's static routes, or an unauthenticated playback URL. Configuration is stored separately from arbitrary panel settings and survives integration/HACS file updates.

Each device can select `off`, `save`, or `review`. The latter two both permit upload; `review` additionally asks the client to show feedback after the interaction finishes. Turning capture off does not delete existing examples. The default retention is seven days and the limit is 250 MiB per satellite. Retention accepts 1–365 days; storage accepts 1–2048 MiB. Hourly cleanup expires both reviewed and unreviewed recordings, including recordings from removed satellites. Upload/review also checks retention. A full store rejects uploads; it does not silently evict recordings. Export useful examples before their retention expires.

The server rejects new uploads as soon as it processes an Off setting. The page where the setting changed refreshes immediately; other active clients poll their policy every thirty seconds. A suspended native WebView cannot receive that change until it resumes, so its bounded in-memory capture queue can continue collecting until then. Once the Off policy reaches the client, it stops recording and clears unsaved clips. Remote Off is therefore not an immediate native microphone-mute command.

## WebSocket commands

All commands use Home Assistant's authenticated WebSocket and include `entity_id`. The command prefix is `voice_satellite/recordings/`. Home Assistant reserves the top-level numeric `id` for message correlation, so recording lookups use **`recording_id`**.

| Command | Additional input | Result |
| --- | --- | --- |
| `config` | None | `{mode, retention_days, max_storage_mb}` |
| `configure` | Required `mode`; optional retention/storage integers | The updated configuration |
| `save` | `capture_id`, `audio_base64`, `metadata` | `{id, duplicate}` after persistent WAV and JSON writes |
| `list` | Optional `label`, `limit` (1–100, default 50), `offset` | `{items, total, config}`, newest first |
| `get` | `recording_id` | `{item, audio_base64}` |
| `label` | `recording_id`, `label`, optional `word_present` | Updated item |
| `delete` | `recording_id` | `{deleted:true}` |

`config` requires an authenticated user and registered satellite. `save` additionally requires control permission for that satellite and enabled recording policy. Administrators may upload to a registered satellite. Configuration and every review operation (`list`, `get`, `label`, `delete`) require an administrator. All lookups enforce the requested satellite's ownership.

Audio must be a complete 16 kHz mono PCM16 WAV, at most ten seconds / 320044 bytes. Base64 is capped at 426728 characters before decoding. IDs are canonical lowercase UUIDs, never paths. Reusing a capture ID with identical audio acknowledges a retry without changing the original metadata or review; different audio with that ID is rejected. An incomplete or corrupted stored recording is not acknowledged as a successful duplicate. The client should remove its queued audio only after the success acknowledgement.

Source metadata is limited to 8 KiB and the following fields: `origin`, `engine`, `model`, `model_sha256`, `score`, `threshold`, `sensitivity`, `session_id`, `captured_at`, `trigger_sample`, `capture_kind`, `sample_rate`, `pre_seconds`, `version`, `microphone_settings`, and `discontinuity`. Unknown fields, deeply nested/large values, non-finite numbers, and credential-like keys are rejected. Scores may be null/omitted when unavailable. `captured_at` must have a timezone. Server time determines retention; client clock errors cannot extend storage indefinitely. `trigger_sample` is a PCM sample offset within the saved clip, including its end.

Items include `id`, `capture_id`, `created_at`, `metadata`, `label`, `word_present`, `bytes`, `sha256`, and bounded `label_history`. Feedback is one of `correct`, `false_trigger`, `unsure`, or `unreviewed`. Acoustic word presence is independent: `present`, `absent`, or `uncertain`. For example, an unintended activation can still contain the actual word. Omitted acoustic feedback preserves the prior value, initially `uncertain`; it is never inferred from the trigger label. History keeps the latest twenty changes with reviewer ID and server timestamp.

Playback remains authenticated: retrieve base64 through `get`, create a local browser blob URL, and revoke it when done. Export/learning code should preserve capture-session IDs and source hashes so related samples stay within the same dataset split. Do not treat unlabeled or uncertain recordings as negative examples.

## Validation

`python -m unittest discover -s tests -p 'test_recordings.py' -v` covers real temporary-directory writes, restart persistence, policy/format limits, quotas, retention, retries/conflicts, ownership/permission failures, explicit labels, concurrent retries, and interrupted writes. The HA-facing tests stub HA registration/wiring and execute the actual handler bodies with storage dispatched to worker threads; they do not claim a live Home Assistant deployment test. Windows may skip the symlink fixture if it lacks creation privileges; Linux CI requires that fixture to run. The wake recording workflow also runs the complete frontend test suite and production build, with no release publishing. Runtime imports and WebSocket decorator registration still need validation on the target Home Assistant version during the local trial.
