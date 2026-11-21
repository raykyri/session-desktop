# Rotate the cursor key

How to replace `SESSION_CURSOR_KEY`, the AES-256-GCM key that seals sync
cursors and the event ids of the sync stream (`01` S3, Y6, Y7; plan `04`
§13 "Cursor tokens"). A cursor holds the log, the reader, the log's history,
a version, the server's head and the time it was served; the key keeps all
of it unreadable and unforgeable. A cursor that does not open, belongs to
another reader or log, or comes from another server resyncs its client: the
client takes a new snapshot of that log. A stolen cursor therefore gives
its holder nothing.

## Settings

| Variable | Value |
| --- | --- |
| `SESSION_CURSOR_KEY` | the current key: 32 bytes of base64 (`openssl rand -base64 32`); required in production |
| `SESSION_CURSOR_KEY_PREVIOUS` | the key before the rotation, accepted alongside the current one |
| `SESSION_CURSOR_KEY_ROTATED_AT` | the ISO time of the rotation; required with the previous key |

The server accepts the previous key until 30 days after
`SESSION_CURSOR_KEY_ROTATED_AT` (`PREVIOUS_KEY_TTL`), for cursors and for
event ids alike, and seals everything new with the current key. Boot fails
when a key is not 32 bytes of base64 or the previous key has no rotation
time (`config.ts`, `cursorKeysFrom`).

Fly does not show a secret's value once set. Keep the current key where the
site admins keep the other production secrets, so that it can become the
previous key at the next rotation.

## Planned rotation (the 30-day overlap)

Use it on a schedule, or when someone who had the key leaves.

1. Make the new key:

   ```sh
   openssl rand -base64 32
   ```

2. Set the three values in one change, so that one deploy applies them.
   The keys go into a file only its owner can read, written with an editor,
   so that no key is on a command line or in the shell history:

   ```sh
   date -u +%Y-%m-%dT%H:%M:%SZ                 # the rotation time
   install -m 600 /dev/null cursor.env
   "$EDITOR" cursor.env
   #   SESSION_CURSOR_KEY_PREVIOUS=<current key>
   #   SESSION_CURSOR_KEY=<new key>
   #   SESSION_CURSOR_KEY_ROTATED_AT=<the rotation time>
   fly secrets import -a <app> < cursor.env
   shred -u cursor.env
   ```

   Without `--stage`, `fly secrets import` is expected to apply the values
   and restart the machine as `fly secrets set` does (unverified,
   `launch.md` §4.13 U5). If it does not, use `fly secrets set` with
   `HISTCONTROL=ignorespace` set and the command typed with a leading space.

   Fly restarts the machine with the new secrets. Open tabs reconnect their
   streams; their cursors and the stream's last event id, sealed with the old
   key, still open, so no client resyncs.
3. Check: `/healthz` answers `ok`; in a signed-in tab opened before the
   rotation, a post from another account still appears without a reload.
4. After 30 days, remove the previous key:

   ```sh
   fly secrets unset -a <app> SESSION_CURSOR_KEY_PREVIOUS SESSION_CURSOR_KEY_ROTATED_AT
   ```

   The server ignores the previous key after 30 days in any case; removing
   it keeps the configuration plain. A cursor still sealed with it resyncs
   once. The web client keeps its replica in tab memory only, so a cursor
   lives no longer than its tab.

## Emergency rotation (the key leaked)

A leaked key lets its holder read the state inside cursors (log ids, a
reader's handle, versions and times) and seal cursors the server accepts.
Such a cursor still reads only what its reader may read, under the read
rules of the time of the read, so it exposes no records; it does expose
the metadata above. Rotate without an overlap:

```sh
install -m 600 /dev/null cursor.env
"$EDITOR" cursor.env                           # SESSION_CURSOR_KEY=<new key>
fly secrets import --stage -a <app> < cursor.env
shred -u cursor.env
fly secrets unset -a <app> SESSION_CURSOR_KEY_PREVIOUS SESSION_CURSOR_KEY_ROTATED_AT
```

The import is staged, and the `unset` is expected to apply both changes
with one restart (unverified, `launch.md` §4.13 U5 and U6).

Every open tab resyncs each log it reads once, which is a snapshot per log
per client: a short load spike, well within the snapshot limits for one
reconnect (`04` Z1: 30 a minute per user).

## Development and test

Unset, development and test servers use a fixed key
(`DEVELOPMENT_CURSOR_KEY`); production refuses to start without one. The
conformance target gives each test server a random key of its own, so a
cursor from one target resyncs on another (`inv3`).
