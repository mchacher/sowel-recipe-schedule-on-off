import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, msUntilTime, applyOffset, toIdList } from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };
type Sun = { sunrise: string | null; sunset: string | null; isDaylight: boolean | null };

function buildCtx(initialSun: Sun = { sunrise: "06:00", sunset: "21:00", isDaylight: true }) {
  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];
  const sunlightHandlers: Array<() => void> = [];
  let sun = initialSun;

  const ctx = {
    eventBus: {
      onType: (type: string, handler: () => void) => {
        if (type === "sunlight.changed") sunlightHandlers.push(handler);
        return () => {};
      },
    },
    equipmentManager: {
      getById: (id: string) => ({ id, name: id, type: "switch" }),
      executeOrder: async (equipmentId: string, alias: string, value: unknown) => {
        orderCalls.push({ equipmentId, alias, value });
        return { success: true };
      },
    },
    zoneManager: { getById: () => null },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    state: {
      get: (k: string) => state.get(k) ?? null,
      set: (k: string, v: unknown) => {
        state.set(k, v);
      },
      delete: (k: string) => {
        state.delete(k);
      },
      clear: () => state.clear(),
    },
    log: (msg: string) => {
      logLines.push(msg);
    },
    helpers: { parseDuration: () => 0, getSunlight: () => sun },
  };

  return {
    ctx,
    orderCalls,
    state,
    logLines,
    setSun: (s: Sun) => {
      sun = s;
    },
    fireSunlightChanged: () => {
      for (const h of sunlightHandlers) h();
    },
  };
}

// ============================================================
// Pure helpers
// ============================================================

describe("msUntilTime", () => {
  it("returns ms to a time later today", () => {
    expect(msUntilTime("10:30", new Date("2026-04-19T08:00:00"))).toBe(2 * 3600_000 + 30 * 60_000);
  });
  it("returns ms to tomorrow when the time has already passed today", () => {
    expect(msUntilTime("10:00", new Date("2026-04-19T12:00:00"))).toBe(22 * 3600_000);
  });
});

describe("applyOffset", () => {
  it("subtracts minutes", () => expect(applyOffset("21:00", -15)).toBe("20:45"));
  it("adds minutes", () => expect(applyOffset("06:00", 90)).toBe("07:30"));
  it("wraps past midnight forward", () => expect(applyOffset("23:50", 30)).toBe("00:20"));
  it("wraps past midnight backward", () => expect(applyOffset("00:10", -20)).toBe("23:50"));
  it("zero offset is identity", () => expect(applyOffset("18:00", 0)).toBe("18:00"));
});

describe("toIdList", () => {
  it("normalizes an array", () => expect(toIdList(["E1", "E2"])).toEqual(["E1", "E2"]));
  it("wraps a single id", () => expect(toIdList("E1")).toEqual(["E1"]));
  it("empty for null/empty", () => {
    expect(toIdList(null)).toEqual([]);
    expect(toIdList("")).toEqual([]);
    expect(toIdList([])).toEqual([]);
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  const recipe = createRecipe();
  const { ctx } = buildCtx();
  const base = { zone: "Z1", equipments: ["E1"] };

  it("rejects missing zone", () => {
    expect(() =>
      recipe.validate({ equipments: ["E1"], slot1_start_kind: "time", slot1_start_time: "10:00", slot1_end_kind: "time", slot1_end_time: "14:00" }, ctx as never),
    ).toThrow(/zone is required/i);
  });

  it("rejects no equipment", () => {
    expect(() =>
      recipe.validate({ zone: "Z1", equipments: [], slot1_start_kind: "time", slot1_start_time: "10:00", slot1_end_kind: "time", slot1_end_time: "14:00" }, ctx as never),
    ).toThrow(/at least one equipment/i);
  });

  it("rejects slot1 fixed-time start with no time", () => {
    expect(() =>
      recipe.validate({ ...base, slot1_start_kind: "time", slot1_end_kind: "time", slot1_end_time: "14:00" }, ctx as never),
    ).toThrow(/slot 1 start and end are required/i);
  });

  it("accepts slot1 with a sunrise start + sunset end (no times needed)", () => {
    expect(() =>
      recipe.validate({ ...base, slot1_start_kind: "sunset", slot1_end_kind: "sunrise" }, ctx as never),
    ).not.toThrow();
  });

  it("accepts a valid fixed-time slot1", () => {
    expect(() =>
      recipe.validate({ ...base, slot1_start_kind: "time", slot1_start_time: "10:00", slot1_end_kind: "time", slot1_end_time: "14:00" }, ctx as never),
    ).not.toThrow();
  });

  it("rejects slot2 with start configured but end missing", () => {
    expect(() =>
      recipe.validate(
        { ...base, slot1_start_kind: "time", slot1_start_time: "10:00", slot1_end_kind: "time", slot1_end_time: "14:00", slot2_start_kind: "sunset", slot2_end_kind: "time" },
        ctx as never,
      ),
    ).toThrow(/slot 2 start and end must both be set/i);
  });
});

// ============================================================
// createInstance()
// ============================================================

describe("createInstance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-19T08:00:00"));
  });
  afterEach(() => vi.useRealTimers());

  const fixed1 = {
    zone: "Z1",
    slot1_start_kind: "time",
    slot1_start_time: "10:00",
    slot1_end_kind: "time",
    slot1_end_time: "14:00",
  };

  it("fires ON at start and OFF at end for every equipment", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx();
    const handle = recipe.createInstance({ ...fixed1, equipments: ["E1", "E2"] }, ctx as never);

    await vi.advanceTimersByTimeAsync(2 * 3600_000); // 10:00
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "ON" });
    expect(orderCalls).toContainEqual({ equipmentId: "E2", alias: "state", value: "ON" });
    expect(state.get("status")).toBe("running");

    await vi.advanceTimersByTimeAsync(4 * 3600_000); // 14:00
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "OFF" });
    expect(state.get("status")).toBe("idle");
    handle.stop();
  });

  it("resolves a sunset-minus-offset start (21:00 - 15 = 20:45)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx({ sunrise: "06:00", sunset: "21:00", isDaylight: true });
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start_kind: "sunset", slot1_start_offset: -15, slot1_end_kind: "time", slot1_end_time: "23:30" },
      ctx as never,
    );
    // 08:00 -> 20:45 is 12h45
    await vi.advanceTimersByTimeAsync(12 * 3600_000 + 45 * 60_000);
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "ON" });
    handle.stop();
  });

  it("reschedules for the next day", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance({ ...fixed1, equipments: ["E1"] }, ctx as never);
    await vi.advanceTimersByTimeAsync(2 * 3600_000); // 10:00 d1
    await vi.advanceTimersByTimeAsync(4 * 3600_000); // 14:00 d1
    expect(orderCalls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(24 * 3600_000); // d2
    expect(orderCalls.length).toBe(4);
    handle.stop();
  });

  it("stop() while running leaves equipments untouched (no forced OFF)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx();
    const handle = recipe.createInstance({ ...fixed1, equipments: ["E1"] }, ctx as never);
    await vi.advanceTimersByTimeAsync(2 * 3600_000); // ON
    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(orderCalls.filter((c) => c.value === "OFF").length).toBe(0);
    expect(orderCalls.length).toBe(1);
    expect(state.get("status")).toBe("idle");
  });

  it("skips a sun boundary when the sun time is null, and arms it on sunlight.changed", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, logLines, setSun, fireSunlightChanged } = buildCtx({ sunrise: null, sunset: null, isDaylight: null });
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start_kind: "sunset", slot1_end_kind: "time", slot1_end_time: "23:00" },
      ctx as never,
    );
    // No sun -> start boundary skipped, nothing fires.
    await vi.advanceTimersByTimeAsync(13 * 3600_000);
    expect(orderCalls.filter((c) => c.value === "ON").length).toBe(0);
    expect(logLines.some((l) => /indisponible/.test(l))).toBe(true);

    // Sun data arrives at 21:00; re-arm. From 21:00 the next 21:00 is +24h.
    setSun({ sunrise: "06:00", sunset: "21:00", isDaylight: true });
    fireSunlightChanged();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(orderCalls.filter((c) => c.value === "ON").length).toBe(1);
    handle.stop();
  });

  it("re-arms a sun boundary to the new time on sunlight.changed", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, setSun, fireSunlightChanged } = buildCtx({ sunrise: "06:00", sunset: "21:00", isDaylight: true });
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start_kind: "sunset", slot1_end_kind: "time", slot1_end_time: "23:30" },
      ctx as never,
    );
    // Sunset moves earlier to 20:00; re-arm so ON fires at 20:00 (12h from 08:00).
    setSun({ sunrise: "06:00", sunset: "20:00", isDaylight: true });
    fireSunlightChanged();
    await vi.advanceTimersByTimeAsync(12 * 3600_000); // 20:00
    expect(orderCalls.filter((c) => c.value === "ON").length).toBe(1);
    handle.stop();
  });
});

describe("equipments slot", () => {
  it("accepts every on/off equipment type, including water_heater (spec 135)", () => {
    const recipe = createRecipe();
    const slot = recipe.slots.find((s) => s.id === "equipments");
    expect(slot).toBeDefined();
    expect(slot?.constraints?.equipmentType).toEqual([
      "switch",
      "light_onoff",
      "light_dimmable",
      "light_color",
      "water_valve",
      "pool_pump",
      "water_heater",
    ]);
  });
});
