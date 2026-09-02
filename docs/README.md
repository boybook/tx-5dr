# Engineering Documentation

This directory contains maintained engineering contracts, durable decisions,
development-only tools, research evidence, and required legal text. User-facing
installation and operation manuals are maintained in
[`tx-5dr-site`](https://github.com/boybook/tx-5dr-site).

## Architecture Contracts

- [Server startup and radio lifecycle](architecture/server-startup.md)
- [Realtime audio ownership and transport](architecture/realtime-audio.md)
- [Spectrum amplitude semantics](architecture/spectrum.md)
- [Persistence durability](architecture/persistence-durability.md)

These files describe invariants that implementation and guard tests are expected
to preserve. Update them when an owning boundary changes.

## Public Extension Contract

- [Plugin API v2 development guide](plugin-system.md)

Public signatures remain defined by `@tx5dr/plugin-api`. The guide explains how
the Host boundary is intended to be used; generated reference pages live in the
site repository.

## Decisions

- [External device panel boundary](decisions/device-panel-boundary.md)
- [TX audio input source capability](decisions/tx-audio-input-source.md)
- [DeepCW engine integration](decisions/deepcw-engine-integration.md)

Decision records retain the accepted boundary and current consequences. They do
not track implementation progress or branch-by-branch task history.

## Development

- [Virtual FT8/FT4 radio](development/virtual-radio.md)

Development documents describe supported test tools that are not normal product
configuration.

## Research

- [ICOM remote protocol and spectrum research](research/icom-remote-protocol.md)
- [ICOM USB/ACC IF demodulation spike](research/icom-usb-if-demod-spike.md)
- [FT8/FT4 contest framework coverage](research/ft8-contest-framework-coverage.md)
- [TX audio input routing: Hamlib provider matrix](research/tx-audio-input-hamlib-matrix.md)

Research files are dated evidence, not compatibility promises. Re-check their
assumptions against current dependencies, hardware, firmware, and captures.

## Legal and Privacy

- [Privacy and diagnostic data](privacy.md)

## Documentation Rules

- Code, runtime schemas, and tests outrank prose when they disagree.
- Do not add completed plans, daily progress logs, generated review reports, or
  credential setup notes as maintained architecture.
- Put temporary work under ignored local directories, not in `docs`.
- Mark experiments and research with status, scope, and evidence date.
- Keep credentials, personal account identifiers, and secret values out of the
  repository.
