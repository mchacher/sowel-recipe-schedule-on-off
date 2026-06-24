# Sowel Recipe: Schedule On/Off

Scheduled on/off for any on/off equipment: **fixed time, sunrise or sunset**, up
to 3 daily windows.

Each window has a **start** (turns the equipment(s) ON) and an **end** (turns
them OFF). Every selected equipment follows the same schedule, which runs **every
day** and re-arms itself automatically. Windows whose end is earlier than their
start cross midnight naturally.

## What it does

- Drives **one or more** equipments on the same schedule
- Up to **3 windows per day** (window 1 required, windows 2 and 3 optional)
- Each boundary (start/end) is **Fixed time**, **Sunrise** or **Sunset**, with an
  optional minute **offset** (e.g. sunset minus 15)
- Sun times come from `ctx.helpers.getSunlight()`; the recipe re-arms its
  sun-based timers on the `sunlight.changed` event so they track the daily drift.
  A day with no sunrise/sunset (polar regions) skips that boundary until the sun
  data returns
- Fires `state = "ON"` at each start, `state = "OFF"` at each end
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
| `slotN_start_kind` / `slotN_end_kind` | select | window 1 | Fixed time / Sunrise / Sunset |
| `slotN_start_time` / `slotN_end_time` | time | no | Used when the kind is Fixed time |
| `slotN_start_offset` / `slotN_end_offset` | number | no | +/- minutes, used for sunrise/sunset |

The form shows only the relevant value field per boundary (the time picker for a
fixed time, the minute offset for sunrise/sunset), via the `hiddenWhen` slot rule.

## Requirements

Sowel **>= 1.23.0** (the recipe uses the `select` slot type, `hiddenWhen`, and
`ctx.helpers.getSunlight()` introduced in spec 126).

## Behaviour on disable

Stopping or disabling an instance **cancels all timers and leaves the equipments
untouched** (no forced OFF). Disabling an automation should not actuate devices;
switch them off yourself if needed.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
```

## Release

Tag `vX.Y.Z` to trigger the GitHub Actions release, then update the SHA256 in the
Sowel `plugins/registry.json` with `scripts/backfill-registry-sha256.mjs`.

## License

AGPL-3.0
