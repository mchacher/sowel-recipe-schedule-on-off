import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, msUntilTime, toIdList } from "./index.js";

// ============================================================
// Test doubles
// ============================================================

type OrderCall = { equipmentId: string; alias: string; value: unknown };

function buildCtx(names: Record<string, string> = {}) {
  const orderCalls: OrderCall[] = [];
  const state = new Map<string, unknown>();
  const logLines: string[] = [];

  const ctx = {
    eventBus: { onType: () => () => {} },
    equipmentManager: {
      getById: (id: string) => ({ id, name: names[id] ?? id, type: "switch" }),
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
    helpers: { parseDuration: () => 0 },
  };

  return { ctx, orderCalls, state, logLines };
}

// ============================================================
// Helpers (exported)
// ============================================================

describe("msUntilTime", () => {
  it("returns ms to a time later today", () => {
    const now = new Date("2026-04-19T08:00:00");
    expect(msUntilTime("10:30", now)).toBe(2 * 3600_000 + 30 * 60_000);
  });

  it("returns ms to tomorrow when the time has already passed today", () => {
    const now = new Date("2026-04-19T12:00:00");
    expect(msUntilTime("10:00", now)).toBe(22 * 3600_000);
  });

  it("handles midnight-crossing — 23:58 at 23:59 fires tomorrow", () => {
    const now = new Date("2026-04-19T23:59:00");
    expect(msUntilTime("23:58", now)).toBe(23 * 3600_000 + 59 * 60_000);
  });
});

describe("toIdList", () => {
  it("normalizes an array of ids", () => {
    expect(toIdList(["E1", "E2"])).toEqual(["E1", "E2"]);
  });

  it("wraps a single id into a one-element array", () => {
    expect(toIdList("E1")).toEqual(["E1"]);
  });

  it("returns an empty array for null/undefined/empty", () => {
    expect(toIdList(null)).toEqual([]);
    expect(toIdList(undefined)).toEqual([]);
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

  it("rejects when zone is missing", () => {
    expect(() =>
      recipe.validate(
        { equipments: ["E1"], slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).toThrow(/zone is required/i);
  });

  it("rejects when no equipment is selected", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", equipments: [], slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).toThrow(/at least one equipment is required/i);
  });

  it("rejects when slot 1 end is missing", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", equipments: ["E1"], slot1_start: "10:00" },
        ctx as never,
      ),
    ).toThrow(/slot 1 start and end are required/i);
  });

  it("rejects slot 2 start without end", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1",
          equipments: ["E1"],
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_start: "20:00",
        },
        ctx as never,
      ),
    ).toThrow(/slot 2 end is required/i);
  });

  it("rejects slot 2 end without start", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1",
          equipments: ["E1"],
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_end: "22:00",
        },
        ctx as never,
      ),
    ).toThrow(/slot 2 start is required/i);
  });

  it("rejects a slot with start == end", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", equipments: ["E1"], slot1_start: "10:00", slot1_end: "10:00" },
        ctx as never,
      ),
    ).toThrow(/start and end must differ/i);
  });

  it("accepts a single valid slot with a single equipment", () => {
    expect(() =>
      recipe.validate(
        { zone: "Z1", equipments: ["E1"], slot1_start: "10:00", slot1_end: "14:00" },
        ctx as never,
      ),
    ).not.toThrow();
  });

  it("accepts two valid slots with multiple equipments", () => {
    expect(() =>
      recipe.validate(
        {
          zone: "Z1",
          equipments: ["E1", "E2"],
          slot1_start: "10:00",
          slot1_end: "14:00",
          slot2_start: "20:00",
          slot2_end: "22:00",
        },
        ctx as never,
      ),
    ).not.toThrow();
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires ON at start and OFF at end for every selected equipment", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1", "E2"], slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );

    // 10:00 → ON for both
    await vi.advanceTimersByTimeAsync(2 * 3600_000);
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "ON" });
    expect(orderCalls).toContainEqual({ equipmentId: "E2", alias: "state", value: "ON" });
    expect(state.get("status")).toBe("running");
    expect(state.get("currentSlot")).toBe("10:00-14:00");

    // 14:00 → OFF for both
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "OFF" });
    expect(orderCalls).toContainEqual({ equipmentId: "E2", alias: "state", value: "OFF" });
    expect(state.get("status")).toBe("idle");
    expect(state.get("currentSlot")).toBe(null);

    handle.stop();
  });

  it("reschedules the slot for the next day after firing", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );

    await vi.advanceTimersByTimeAsync(2 * 3600_000); // 10:00 day 1
    await vi.advanceTimersByTimeAsync(4 * 3600_000); // 14:00 day 1
    expect(orderCalls.length).toBe(2);

    await vi.advanceTimersByTimeAsync(24 * 3600_000); // day 2
    expect(orderCalls.length).toBe(4);
    expect(orderCalls[2].value).toBe("ON");
    expect(orderCalls[3].value).toBe("OFF");

    handle.stop();
  });

  it("handles midnight-crossing slots", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    vi.setSystemTime(new Date("2026-04-19T23:57:00"));
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start: "23:58", slot1_end: "00:02" },
      ctx as never,
    );

    await vi.advanceTimersByTimeAsync(60_000); // 23:58 → ON
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "ON" });

    await vi.advanceTimersByTimeAsync(4 * 60_000); // 00:02 → OFF
    expect(orderCalls).toContainEqual({ equipmentId: "E1", alias: "state", value: "OFF" });

    handle.stop();
  });

  it("drives independent windows (slot 1 and slot 2)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      {
        zone: "Z1",
        equipments: ["E1"],
        slot1_start: "10:00",
        slot1_end: "11:00",
        slot2_start: "20:00",
        slot2_end: "21:00",
      },
      ctx as never,
    );

    await vi.advanceTimersByTimeAsync(2 * 3600_000); // 10:00 ON
    await vi.advanceTimersByTimeAsync(1 * 3600_000); // 11:00 OFF
    await vi.advanceTimersByTimeAsync(9 * 3600_000); // 20:00 ON
    await vi.advanceTimersByTimeAsync(1 * 3600_000); // 21:00 OFF

    expect(orderCalls.map((c) => c.value)).toEqual(["ON", "OFF", "ON", "OFF"]);
    handle.stop();
  });

  it("stop() while idle cancels timers and sends nothing", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );
    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(orderCalls.length).toBe(0);
  });

  it("stop() while running leaves equipments untouched (no forced OFF)", async () => {
    const recipe = createRecipe();
    const { ctx, orderCalls, state } = buildCtx();
    const handle = recipe.createInstance(
      { zone: "Z1", equipments: ["E1"], slot1_start: "10:00", slot1_end: "14:00" },
      ctx as never,
    );

    await vi.advanceTimersByTimeAsync(2 * 3600_000); // running (ON sent)
    expect(orderCalls.filter((c) => c.value === "ON").length).toBe(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(0);
    // No OFF issued on stop, and the timers are cancelled (no further orders).
    expect(orderCalls.filter((c) => c.value === "OFF").length).toBe(0);
    expect(state.get("status")).toBe("idle");

    await vi.advanceTimersByTimeAsync(10 * 3600_000);
    expect(orderCalls.length).toBe(1); // still just the single ON
  });
});
