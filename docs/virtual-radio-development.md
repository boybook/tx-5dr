# Virtual FT8/FT4 radio (development only)

The virtual radio is intentionally unavailable through the Profile UI and public Profile API. It starts only when all of these are true:

- the active Profile in `config.json` has `radio.type` set to `virtual`;
- `TX5DR_ENABLE_VIRTUAL_RADIO=1` is set;
- `TX5DR_CONFIG_DIR` and `TX5DR_DATA_DIR` are both explicit and point to different development directories;
- PSK Reporter and rigctld are disabled;
- every enabled utility plugin is disabled or listed in `externalUtilityAllowlist`.

Do not point either directory at a normal TX-5DR installation. The isolated data directory owns the test ADIF files, plugin storage, WW Digi session data, and simulator traces.

## Example

Add a Profile like this to an isolated `config.json`, set its ID as `activeProfileId`, and configure the operator to use the WW Digi strategy:

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
          "externalUtilityAllowlist": [],
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

Start the development runtime with isolated paths:

```sh
TX5DR_ENABLE_VIRTUAL_RADIO=1 \
TX5DR_CONFIG_DIR=/absolute/path/to/virtual-config \
TX5DR_DATA_DIR=/absolute/path/to/virtual-data \
yarn dev
```

The server log reports the JSONL trace path for each session. Test QSOs use the ordinary logbook UI because the entire data directory is isolated.

The first version uses the real system UTC clock. Before the contest window, WW Digi Cabrillo reconciliation intentionally excludes these test QSOs even though the baseband QSO and ADIF persistence complete normally.
