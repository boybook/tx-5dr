# Virtual FT8/FT4 radio (development only)

The virtual radio is configured only through `config.json`; the Profile creation and edit forms cannot create or modify it. Once configured, it appears in the Profile list as a read-only virtual radio and can be activated like any other Profile.

- The active Profile in `config.json` must have `radio.type` set to `virtual`.
- PSK Reporter and rigctld must be disabled while the virtual Profile is active.
- Use a dedicated virtual operator callsign so normal callsign-scoped ADIF and contest sessions remain separate.

Separate config and data directories are optional. When the normal data directory is used, simulator traces and frame logs share that directory, while QSO records remain isolated by the virtual operator callsign. External sync and broadcast plugins are not automatically disabled; pause them if they must not receive simulated QSOs.

## Example

Add a Profile like this to `config.json`, then configure a dedicated operator to use the WW Digi strategy:

```json
{
  "activeProfileId": "virtual-ww-digi",
  "profiles": [
    {
      "id": "virtual-ww-digi",
      "name": "Virtual WW Digi",
      "radio": {
        "type": "virtual",
        "virtual": {
          "dialFrequencyHz": 14090000,
          "scenarioProvider": "ww-digi",
          "seed": "ww-digi-regression-1",
          "peers": [
            { "id": "peer-1", "callsign": "JA1AAA", "grid": "PM95", "scenarioId": "standard", "audioFrequencyHz": 1200 },
            { "id": "peer-2", "callsign": "JA2BBB", "grid": "PM96", "scenarioId": "repeat-final-wait-73", "audioFrequencyHz": 1500 },
            { "id": "peer-3", "callsign": "JA3CCC", "grid": "PM97", "scenarioId": "seeded-random", "audioFrequencyHz": 1800, "dropProbability": 0.1, "frequencyOffsetHz": 8, "timingOffsetMs": 120 }
          ]
        }
      },
      "audioLockedToRadio": true,
      "createdAt": 0,
      "updatedAt": 0
    }
  ],
  "pskreporter": { "enabled": false },
  "rigctld": { "enabled": false },
  "plugins": {
    "configs": {
      "autocall-idle-frequency": { "enabled": false, "settings": {} },
      "wavelog-sync": { "enabled": false, "settings": {} },
      "qrz-sync": { "enabled": false, "settings": {} },
      "lotw-sync": { "enabled": false, "settings": {} },
      "clublog-sync": { "enabled": false, "settings": {} },
      "qso-udp-broadcast": { "enabled": false, "settings": {} }
    },
    "operatorStrategies": { "operator-1": "ww-digi" }
  }
}
```

Peers may opt into a scenario-owned callsign/grid pool with `"identityPool": "scenario"`. This keeps the configured RF peer count, frequencies, encoder load, and mixer load bounded while rotating each peer through a larger identity set. The selected scenario must declare enough identities for every peer using that pool.

Start the normal Electron development runtime:

```sh
yarn dev:electron
```

The server log reports the JSONL trace path for each session. Test QSOs use the ordinary callsign-scoped logbook and WW Digi page.

The first version uses the real system UTC clock. Before the contest window, WW Digi Cabrillo reconciliation intentionally excludes these test QSOs even though the baseband QSO and ADIF persistence complete normally.
