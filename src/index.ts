/**
 * Sowel Recipe: Schedule On/Off
 *
 * Drives one or more on/off equipments on a fixed daily schedule. Up to three
 * windows per day; each window has a start time (fires ON) and an end time
 * (fires OFF). Every selected equipment receives the same ON/OFF orders.
 *
 * At each start the recipe fires `executeOrder(id, "state", "ON")` for every
 * equipment, at each end `"OFF"`. End times earlier than their start cross
 * midnight naturally: `msUntilTime` schedules each timer independently and the
 * timer re-arms itself for the next day after it fires.
 *
 * Stopping the instance cancels every timer and leaves the equipments untouched
 * (no forced OFF). Disabling an automation should not actuate devices; if the
 * user wants the equipment off, they switch it off themselves.
 */

// ============================================================
// Types (mirrored from Sowel core — recipe plugins don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): RecipeInstanceHandle;
}

interface Equipment {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

interface RecipeStateStore {
  get(key: string): unknown | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
}

interface EquipmentManager {
  getById(id: string): Equipment | null;
  executeOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

interface RecipeContext {
  eventBus: { onType(type: string, handler: (event: unknown) => void): () => void };
  equipmentManager: EquipmentManager;
  zoneManager: { getById(id: string): unknown | null };
  logger: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
    debug(obj: Record<string, unknown>, msg: string): void;
  };
  state: RecipeStateStore;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: { parseDuration(value: unknown): number };
}

// ============================================================
// Slot model
// ============================================================

interface Window {
  index: number; // 1..3
  start: string; // "HH:MM"
  end: string; // "HH:MM"
}

/** On/off equipment types this recipe can drive (state ON/OFF order). */
const SUPPORTED_TYPES = [
  "switch",
  "light_onoff",
  "light_dimmable",
  "light_color",
  "water_valve",
  "pool_pump",
];

// ============================================================
// Helpers
// ============================================================

/** Compute ms from now to the next occurrence of HH:MM local time. */
export function msUntilTime(time: string, now: Date = new Date()): number {
  const [h, m] = time.split(":").map(Number);
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() - now.getTime();
}

function isValidHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function windowLabel(w: Window): string {
  return `${w.start}-${w.end}`;
}

function buildWindows(params: Record<string, unknown>): Window[] {
  const windows: Window[] = [];
  for (const n of [1, 2, 3]) {
    const start = params[`slot${n}_start`];
    const end = params[`slot${n}_end`];
    if (isValidHHMM(start) && isValidHHMM(end)) {
      windows.push({ index: n, start, end });
    }
  }
  return windows;
}

/** Normalize an equipment slot value (list or single) to a clean id array. */
export function toIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

// ============================================================
// Slot definitions
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone the equipments belong to",
      type: "zone",
      required: true,
    },
    {
      id: "equipments",
      name: "Equipments",
      description: "On/off equipments to drive on the schedule",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: SUPPORTED_TYPES },
    },

    // Slot 1 — required
    {
      id: "slot1_start",
      name: "Start",
      description: "Turn-on time",
      type: "time",
      required: true,
      group: "slot1",
    },
    {
      id: "slot1_end",
      name: "End",
      description: "Turn-off time",
      type: "time",
      required: true,
      group: "slot1",
    },

    // Slot 2 — optional pair
    {
      id: "slot2_start",
      name: "Start",
      description: "Turn-on time",
      type: "time",
      required: false,
      group: "slot2",
    },
    {
      id: "slot2_end",
      name: "End",
      description: "Turn-off time",
      type: "time",
      required: false,
      group: "slot2",
    },

    // Slot 3 — optional pair
    {
      id: "slot3_start",
      name: "Start",
      description: "Turn-on time",
      type: "time",
      required: false,
      group: "slot3",
    },
    {
      id: "slot3_end",
      name: "End",
      description: "Turn-off time",
      type: "time",
      required: false,
      group: "slot3",
    },
  ];
}

// ============================================================
// i18n
// ============================================================

const FR: RecipeLangPack = {
  name: "Programmation horaire",
  description:
    "Plages horaires marche/arrêt pour des équipements on/off, jusqu'à 3 créneaux par jour",
  slots: {
    zone: { name: "Zone", description: "Zone des équipements" },
    equipments: {
      name: "Équipements",
      description: "Équipements on/off à piloter sur les créneaux",
    },
    slot1_start: { name: "Début", description: "Heure de mise en marche" },
    slot1_end: { name: "Fin", description: "Heure d'arrêt" },
    slot2_start: { name: "Début", description: "Heure de mise en marche" },
    slot2_end: { name: "Fin", description: "Heure d'arrêt" },
    slot3_start: { name: "Début", description: "Heure de mise en marche" },
    slot3_end: { name: "Fin", description: "Heure d'arrêt" },
  },
  groups: {
    slot1: "Créneau 1",
    slot2: "Créneau 2",
    slot3: "Créneau 3",
  },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "schedule-on-off",
    name: "Schedule On/Off",
    description:
      "Scheduled on/off for any on/off equipment, up to 3 daily time windows",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params) {
      if (!params.zone) {
        throw new Error("Zone is required");
      }
      if (toIdList(params.equipments).length === 0) {
        throw new Error("At least one equipment is required");
      }

      // Slot 1 must be complete.
      if (!params.slot1_start || !params.slot1_end) {
        throw new Error("Slot 1 start and end are required");
      }

      // Slots 2 and 3: start and end come as a pair.
      for (const n of [2, 3]) {
        const start = params[`slot${n}_start`];
        const end = params[`slot${n}_end`];
        if (start && !end) {
          throw new Error(`Slot ${n} end is required when start is set`);
        }
        if (end && !start) {
          throw new Error(`Slot ${n} start is required when end is set`);
        }
      }

      // Every configured window must have start != end.
      for (const n of [1, 2, 3]) {
        const start = params[`slot${n}_start`];
        const end = params[`slot${n}_end`];
        if (start && end && start === end) {
          throw new Error(`Slot ${n} start and end must differ`);
        }
      }
    },

    createInstance(params, ctx) {
      const equipmentIds = toIdList(params.equipments);
      const windows = buildWindows(params);

      const nameOf = (id: string): string =>
        ctx.equipmentManager.getById(id)?.name ?? id.slice(0, 8);
      const namesOf = (ids: string[]): string => ids.map(nameOf).join(", ");

      const startTimers = new Map<number, ReturnType<typeof setTimeout>>();
      const endTimers = new Map<number, ReturnType<typeof setTimeout>>();

      async function dispatch(value: "ON" | "OFF"): Promise<void> {
        await Promise.all(
          equipmentIds.map(async (id) => {
            try {
              const res = await ctx.equipmentManager.executeOrder(id, "state", value);
              if (res && res.success === false) {
                ctx.log(`Erreur ${value} ${nameOf(id)} : ${res.error ?? "échec"}`, "error");
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              ctx.log(`Erreur ${value} ${nameOf(id)} : ${msg}`, "error");
            }
          }),
        );
      }

      async function fireOn(w: Window): Promise<void> {
        await dispatch("ON");
        ctx.state.set("status", "running");
        ctx.state.set("currentSlot", windowLabel(w));
        ctx.log(`Marche créneau ${windowLabel(w)} (${namesOf(equipmentIds)})`);
      }

      async function fireOff(w: Window): Promise<void> {
        await dispatch("OFF");
        ctx.state.set("status", "idle");
        ctx.state.set("currentSlot", null);
        ctx.log(`Arrêt créneau ${windowLabel(w)} (${namesOf(equipmentIds)})`);
      }

      function scheduleStart(w: Window): void {
        const delay = msUntilTime(w.start);
        const timer = setTimeout(() => {
          fireOn(w).catch((err) =>
            ctx.logger.error({ err, slot: w.start }, "Start fire failed"),
          );
          scheduleStart(w); // re-arm for tomorrow
          updateNextLabels();
        }, delay);
        startTimers.set(w.index, timer);
      }

      function scheduleEnd(w: Window): void {
        const delay = msUntilTime(w.end);
        const timer = setTimeout(() => {
          fireOff(w).catch((err) =>
            ctx.logger.error({ err, slot: w.end }, "End fire failed"),
          );
          scheduleEnd(w); // re-arm for tomorrow
          updateNextLabels();
        }, delay);
        endTimers.set(w.index, timer);
      }

      function updateNextLabels(): void {
        if (windows.length === 0) {
          ctx.state.set("nextStart", null);
          ctx.state.set("nextEnd", null);
          return;
        }
        const nextStart = [...windows].sort(
          (a, b) => msUntilTime(a.start) - msUntilTime(b.start),
        )[0].start;
        const nextEnd = [...windows].sort(
          (a, b) => msUntilTime(a.end) - msUntilTime(b.end),
        )[0].end;
        ctx.state.set("nextStart", nextStart);
        ctx.state.set("nextEnd", nextEnd);
      }

      // ── Initialize ──

      ctx.state.set("status", "idle");
      ctx.state.set("currentSlot", null);
      for (const w of windows) {
        scheduleStart(w);
        scheduleEnd(w);
      }
      updateNextLabels();

      const labels = windows.map(windowLabel).join(", ");
      ctx.log(
        `Recette démarrée : ${equipmentIds.length} équipement(s), ${windows.length} créneau(x) [${labels}]`,
      );

      return {
        stop(): void {
          for (const t of startTimers.values()) clearTimeout(t);
          for (const t of endTimers.values()) clearTimeout(t);
          startTimers.clear();
          endTimers.clear();

          // Leave equipments untouched (no forced OFF): disabling an automation
          // should not actuate devices.
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);
          ctx.log("Recette arrêtée");
        },
      };
    },
  };
}
