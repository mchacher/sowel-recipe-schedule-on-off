# Sowel Recipe: Schedule On/Off

Scheduled on/off for any on/off equipment, up to 3 daily time windows.

A generic time scheduler: each window has a **start time** (turns the
equipment(s) ON) and an **end time** (turns them OFF). The schedule runs
**every day** and re-arms itself automatically. Windows whose end is earlier
than their start cross midnight naturally.

It is the plain-vanilla sibling of `pool-pump-schedule`: same windowed model,
but it drives any on/off equipment in the zone instead of a single pool pump.

## What it does

- Drives **one or more** equipments on the same schedule
- Up to **3 windows per day** (window 1 required, windows 2 and 3 optional)
- Fires `state = "ON"` at each start, `state = "OFF"` at each end
- Re-arms each window for the next day after it fires
- Exposes live state to the UI: `status` (`idle` / `running`), `currentSlot`,
  `nextStart`, `nextEnd`

## Supported equipment types

`switch`, `light_onoff`, `light_dimmable`, `light_color`, `water_valve`,
`pool_pump`. The equipment picker is scoped to the recipe's zone.

> Lights are switched on/off only (no brightness or colour is set).
> `heater` is intentionally excluded because its fil-pilote relay is inverted
> (relay OFF = comfort), which would make ON/OFF scheduling counter-intuitive.

## Slots

| Slot | Type | Required | Notes |
| ---- | ---- | -------- | ----- |
| `zone` | zone | yes | Zone the equipments belong to |
| `equipments` | equipment (list) | yes | One or more on/off equipments |
| `slot1_start` / `slot1_end` | time | yes | Window 1 (ON / OFF) |
| `slot2_start` / `slot2_end` | time | no | Window 2 (pair) |
| `slot3_start` / `slot3_end` | time | no | Window 3 (pair) |

## Behaviour on disable

Stopping or disabling an instance **cancels all timers and leaves the
equipments untouched** (no forced OFF). Disabling an automation should not
actuate devices; switch them off yourself if needed.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
```

## Release

Tag `vX.Y.Z` to trigger the GitHub Actions release, then update the SHA256 in
the Sowel `plugins/registry.json` with `scripts/backfill-registry-sha256.mjs`.

## License

AGPL-3.0
