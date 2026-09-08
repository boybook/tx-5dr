# Client Notification Ownership

The web client owns event notification preferences, event deduplication and
delivery. Browser, Electron and Android clients share this implementation.
Preferences are local to the origin and are not station configuration. The
versioned client preferences import the legacy QSO flag only when the new key
does not exist; reads do not write migrations. All settings entry points share
one controller.

The application subscribes once to existing WebSocket events. QSO records produce
system notifications only in the background with notification permission. RX
FT8/FT4 messages can produce sound when the existing structured parser identifies
both the sender and a destination matching a client-enabled operator. Unknown
identities, free text, CQ and TX frames do not produce reply notifications.

Reply identity is the pair of local and remote callsigns. Each directed message
renews a two-minute inactivity window, measured using slot timestamps. A slot
can alert only once across staged updates and multiple callers. Replay and
initial snapshots establish deduplication baselines without delivery; old or
out-of-order messages cannot rearm a caller. Disconnect resets reply state and
reconnection waits for handshake completion. Caches are bounded and subscriptions
are removed with their owning client.

The sound player owns a separate Web Audio context connected only to the local
default output. It does not use radio monitoring, capture or TX audio resources.
Assets are bundled CC0 recordings. User gestures unlock playback, and blocked or
unprepared event sounds are dropped instead of queued. Turning sound off stops
current and pending playback. System-notification permissions do not gate audio.

New event types belong in the client event union and explicit handlers, with
separate event policy and output drivers. This boundary does not provide server
or plugin notification APIs. Multiple open clients deliver independently.
