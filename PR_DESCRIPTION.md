# Summary

This PR adds documentation for the new user-scoped plugin panel metadata API.

It covers:

- `ctx.ui.setPanelMetaForUser(panelId, tokenId, meta)` in the plugin API README
- `PluginPanelMetaPayload.viewerTokenId` in the plugin system guide
- host delivery and frontend merge semantics for global vs user-scoped panel meta

# Why

We recently added support for per-user panel metadata overrides so plugins can
show different UI state to different authenticated users, such as clearing an
unread highlight for the sender while keeping it visible for everyone else.

Without documentation, plugin authors would not know:

- when to use `setPanelMeta()` vs `setPanelMetaForUser()`
- that user-scoped metadata is only delivered to the matching token
- that frontend resolution order is `global -> user-scoped`

# Changes

- Updated `packages/plugin-api/README.md` with a new `Runtime UI Metadata`
  section and examples
- Updated `docs/plugin-system.md` interface docs for `UIBridge`
- Added protocol-level documentation for `PluginPanelMetaPayload.viewerTokenId`
  and the host filtering rules

# Testing

- No tests were run because this PR only updates documentation
