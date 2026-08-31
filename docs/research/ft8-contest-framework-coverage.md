# FT8/FT4 Contest Framework Coverage

Status: researched on 2026-08-31. Scope: public FT8/FT4 contest families that
were discoverable from official rules pages or contest calendars at this date.
This is not a claim that every local one-off club event has been enumerated.

## Summary

The current `@tx5dr/plugin-api/contest` surface can model the rule families we
surveyed without a Host change. The new shared helpers are enough for:

- distance-based contests;
- fixed-points contests;
- per-band / per-contest multipliers;
- zero-point-but-multiplier-eligible QSOs;
- custom exchange codecs and completion rules;
- contest-specific session/workbench behavior.

That means the framework is lossless for score/exchange/dupe/export modeling.
Contest-specific lifecycle policy, logging validation, operating-hour limits,
and team aggregation still belong in the plugin itself.

## Surveyed Families

| Contest family | Rule shape | Framework mapping | Lossless? |
| --- | --- | --- | --- |
| [WW Digi DX Contest](https://ww-digi.com/rules/) | FT4/FT8, 4-grid exchange, 1 + 1/3000 km, 2-char grid fields per band | `defineFT8Contest()` + `distancePoints()` + `gridFieldMultiplier()` + `oncePerBand()` | Yes |
| [ARRL International Digital Contest](https://contests.arrl.org/ContestRules/Digital-Rules.pdf) | Any non-RTTY digital mode, 4-grid exchange, 1 + ceil(distance/500 km), no multipliers | `distancePoints({ rounding: 'ceil', minimumDistanceSteps: 1 })` | Yes |
| [FT Roundup](https://www.rttycontesting.com/ft-roundup/rules/) | FT4/FT8, 4-grid exchange, 1 + 1/3000 km, grid field multipliers | `distancePoints()` + `gridFieldMultiplier()` | Yes |
| [FT Challenge](https://www.rttycontesting.com/ft-challenge/rules/) | FT4/FT8, 4-grid + SNR, 1 + 1/3000 km, grid field multipliers, ZZ00 allowed at 1 point | custom `FT8ExchangeModule` + `scoreBy()` + `gridFieldMultiplier()` | Yes |
| [European FT8 Club FT8 DX / FT4 DX](https://europeanft8club.wordpress.com/) | FT8 or FT4, 4-grid exchange, 1 + 1/3000 km, grid field multipliers | `distancePoints()` + `gridFieldMultiplier()` | Yes |
| [RSGB FT4 International Activity Day](https://www.rsgbcc.org/hf/rules/2026/rallband_ft4.shtml) | FT4, signal report only, same-continent = 1, different continent = 3, DXCC country per band | `scoreBy()` + `multiplierKeysFrom()` + contest-specific continent lookup | Yes |
| [RSGB FT4 Contest Series](https://www.rsgbcc.org/hf/rules/2026/r80m_ft4.shtml) | FT4, signal report only, same scoring family as above, monthly aggregation | same as above, plus plugin-owned series aggregation | Yes |
| [VHF-UHF FT8 Activity Europe](https://ft8activity.eu/rules/) | FT8/FT4, 4-grid, 1 point per unique callsign, grid multiplier per round, log cross-check majority rule | `fixedPoints(1)` + `gridFieldMultiplier()` + plugin-owned validation | Yes |
| [VHF-UHF FT8 Activity-NA](https://ft8activity-na.net/rules/) | FT8/FT4, 4-grid, 1 point per unique callsign, grid multiplier, monthly rounds | `fixedPoints(1)` + `gridFieldMultiplier()` | Yes |
| [NCCC FT4 Sprint](https://www.contestcalendar.com/contestdetails.php?ref=741) | FT4, 4-grid, 1 point per QSO, 4-grid multipliers per band | `fixedPoints(1)` + `gridFieldMultiplier()` | Yes |
| [Batavia FT8 Contest](https://www.contestcalendar.com/contestdetails.php?ref=677) | FT8, 4-grid, YB/non-YB country table, prefix + DXCC multipliers, zero-point same-country QSOs | `scoreBy()` + `multiplierKeysFrom()` | Yes |
| [YBDXPI FT8 Contest](https://orari.or.id/event/ybdxpi-ft8-contest/) | FT8, 4-grid, Indonesia-vs-DX-vs-member point table, prefix + DXCC multipliers | `scoreBy()` + `multiplierKeysFrom()` | Yes |
| [Africa FT4 DX Contest](https://mysarl.org.za/contest-resources/) | FT4, signal + grid, continent-based point table, no multipliers | `scoreBy()` | Yes |

## What Is Still Plugin-Owned

- off-time / operating-hour limits;
- team scoring or score normalization across rounds;
- station category, remote-operation, and power policy;
- spot/self-spot policy;
- multi-radio or simultaneous-signal restrictions;
- majority-validation or cross-check logic beyond basic score projection;
- Cabrillo headers and upload workflow.

These are all still representable inside a plugin via the existing session,
workbench, runtime, and submission modules. They do not require Host branches
keyed to a contest name.

## Conclusion

For the contest families surveyed here, the framework is lossless for the rule
objects that matter to scoring and export. The only thing it does not try to do
is become a generic contest engine with hidden policy. That remains the plugin’s
job.
