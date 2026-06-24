/**
 * Sowel Recipe: Schedule On/Off (v2 — sun-aware)
 *
 * Drives one or more on/off equipments on a fixed daily schedule. Up to three
 * windows per day; each window has a start (fires ON) and an end (fires OFF).
 * Every selected equipment receives the same ON/OFF orders.
 *
 * Each boundary (start or end) is one of:
 *  - **Fixed time** — a literal `"HH:MM"`.
 *  - **Sunrise** / **Sunset** — today's sun time (spec 023 offsets) plus a
 *    per-boundary minute offset (e.g. sunset minus 15).
 *
 * Sun times come from `ctx.helpers.getSunlight()` (spec 126). They drift a few
 * minutes per day, so the recipe re-arms its sun-based timers whenever the
 * engine emits `sunlight.changed` (new day / daylight transition). On a day
 * with no sunrise/sunset (polar regions → null), the affected boundary is
 * skipped for that day and re-armed when the sun data comes back.
 *
 * Stopping the instance cancels every timer and leaves the equipments
 * untouched (no forced OFF).
 */

// ============================================================
// Types (mirrored from Sowel core — recipe plugins don't import core)
// ============================================================

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: { equipmentType?: string | string[]; min?: number; max?: number };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  options?: Record<string, string>;
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
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
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

interface Sunlight {
  sunrise: string | null;
  sunset: string | null;
  isDaylight: boolean | null;
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
  helpers: { parseDuration(value: unknown): number; getSunlight(): Sunlight };
}

// ============================================================
// Boundary model
// ============================================================

type BoundaryKind = "time" | "sunrise" | "sunset";

interface Boundary {
  kind: BoundaryKind;
  time: string | null; // "HH:MM" when kind === "time"
  offset: number; // minutes, applied to sunrise/sunset
}

interface Window {
  index: number; // 1..3
  start: Boundary;
  end: Boundary;
}

const SUPPORTED_TYPES = [
  "switch",
  "light_onoff",
  "light_dimmable",
  "light_color",
  "water_valve",
  "pool_pump",
];

const KIND_OPTIONS = [
  { value: "time", label: "Fixed time" },
  { value: "sunrise", label: "Sunrise" },
  { value: "sunset", label: "Sunset" },
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

/** Shift an "HH:MM" by a signed minute offset, wrapping at midnight. */
export function applyOffset(hhmm: string, offsetMin: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m + (Number.isFinite(offsetMin) ? offsetMin : 0);
  total = ((total % 1440) + 1440) % 1440;
  const H = Math.floor(total / 60);
  const M = total % 60;
  return `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`;
}

/** Normalize an equipment slot value (list or single) to a clean id array. */
export function toIdList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((s) => s.length > 0);
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function asKind(value: unknown): BoundaryKind {
  return value === "sunrise" || value === "sunset" ? value : "time";
}

function asOffset(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/** A boundary is "configured" when it can yield a time: a fixed HH:MM, or any
 *  sun kind (resolvable later from getSunlight). */
function boundaryConfigured(b: Boundary): boolean {
  return b.kind === "time" ? isValidHHMM(b.time) : true;
}

function readBoundary(params: Record<string, unknown>, prefix: string): Boundary {
  const kind = asKind(params[`${prefix}_kind`]);
  const time = isValidHHMM(params[`${prefix}_time`]) ? (params[`${prefix}_time`] as string) : null;
  return { kind, time, offset: asOffset(params[`${prefix}_offset`]) };
}

function buildWindows(params: Record<string, unknown>): Window[] {
  const windows: Window[] = [];
  for (const n of [1, 2, 3]) {
    const start = readBoundary(params, `slot${n}_start`);
    const end = readBoundary(params, `slot${n}_end`);
    if (boundaryConfigured(start) && boundaryConfigured(end)) {
      windows.push({ index: n, start, end });
    }
  }
  return windows;
}

function boundaryLabel(b: Boundary): string {
  if (b.kind === "time") return b.time ?? "??:??";
  const sign = b.offset > 0 ? `+${b.offset}` : b.offset < 0 ? `${b.offset}` : "";
  const name = b.kind === "sunrise" ? "lever" : "coucher";
  return `${name}${sign ? ` ${sign}min` : ""}`;
}

function windowLabel(w: Window): string {
  return `${boundaryLabel(w.start)} → ${boundaryLabel(w.end)}`;
}

// ============================================================
// Slot definitions
// ============================================================

function boundarySlots(n: number, which: "start" | "end"): RecipeSlotDef[] {
  const prefix = `slot${n}_${which}`;
  const group = `slot${n}`;
  const required = n === 1; // only window 1 is mandatory
  const head = which === "start" ? "Start" : "End";
  return [
    {
      id: `${prefix}_kind`,
      name: head,
      description: `${head}: fixed time, sunrise or sunset`,
      type: "select",
      required,
      defaultValue: "time",
      options: KIND_OPTIONS,
      group,
    },
    {
      id: `${prefix}_time`,
      name: `${head} time`,
      description: "Used when the type is Fixed time",
      type: "time",
      required: false,
      hiddenWhen: { slot: `${prefix}_kind`, equals: ["sunrise", "sunset"] },
      group,
    },
    {
      id: `${prefix}_offset`,
      name: "Offset +/- (min)",
      description: "Minutes before (-) or after (+) sunrise/sunset",
      type: "number",
      required: false,
      defaultValue: 0,
      hiddenWhen: { slot: `${prefix}_kind`, equals: "time" },
      constraints: { min: -180, max: 180 },
      group,
    },
  ];
}

function buildSlots(): RecipeSlotDef[] {
  return [
    { id: "zone", name: "Zone", description: "Zone the equipments belong to", type: "zone", required: true },
    {
      id: "equipments",
      name: "Equipments",
      description: "On/off equipments to drive on the schedule",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: SUPPORTED_TYPES },
    },
    ...boundarySlots(1, "start"),
    ...boundarySlots(1, "end"),
    ...boundarySlots(2, "start"),
    ...boundarySlots(2, "end"),
    ...boundarySlots(3, "start"),
    ...boundarySlots(3, "end"),
  ];
}

// ============================================================
// i18n
// ============================================================

function boundaryI18n(which: "start" | "end"): Record<string, RecipeSlotI18n> {
  const head = which === "start" ? "Début" : "Fin";
  const out: Record<string, RecipeSlotI18n> = {};
  for (const n of [1, 2, 3]) {
    const prefix = `slot${n}_${which}`;
    out[`${prefix}_kind`] = {
      name: head,
      description: `${head} : heure fixe, lever ou coucher du soleil`,
      options: { time: "Heure fixe", sunrise: "Lever du soleil", sunset: "Coucher du soleil" },
    };
    out[`${prefix}_time`] = { name: `Heure ${head.toLowerCase()}`, description: "Utilisée si le type est Heure fixe" };
    out[`${prefix}_offset`] = {
      name: "Décalage +/- (min)",
      description: "Minutes avant (-) ou après (+) le lever/coucher",
    };
  }
  return out;
}

const FR: RecipeLangPack = {
  name: "Programmation horaire",
  description:
    "Plages horaires marche/arrêt pour des équipements on/off : heure fixe, lever ou coucher du soleil, jusqu'à 3 créneaux par jour",
  slots: {
    zone: { name: "Zone", description: "Zone des équipements" },
    equipments: { name: "Équipements", description: "Équipements on/off à piloter sur les créneaux" },
    ...boundaryI18n("start"),
    ...boundaryI18n("end"),
  },
  groups: { slot1: "Créneau 1", slot2: "Créneau 2", slot3: "Créneau 3" },
};

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "schedule-on-off",
    name: "Schedule On/Off",
    description:
      "Scheduled on/off for any on/off equipment: fixed time, sunrise or sunset, up to 3 daily windows",
    slots: buildSlots(),
    i18n: { fr: FR },

    validate(params) {
      if (!params.zone) throw new Error("Zone is required");
      if (toIdList(params.equipments).length === 0) {
        throw new Error("At least one equipment is required");
      }

      const w1Start = readBoundary(params, "slot1_start");
      const w1End = readBoundary(params, "slot1_end");
      if (!boundaryConfigured(w1Start) || !boundaryConfigured(w1End)) {
        throw new Error("Slot 1 start and end are required (a fixed time, or sunrise/sunset)");
      }

      // Slots 2 and 3: start and end come as a pair.
      for (const n of [2, 3]) {
        const start = readBoundary(params, `slot${n}_start`);
        const end = readBoundary(params, `slot${n}_end`);
        const startSet = boundaryConfigured(start);
        const endSet = boundaryConfigured(end);
        if (startSet !== endSet) {
          throw new Error(`Slot ${n} start and end must both be set`);
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
      const warnedNull = new Set<string>();

      /** Resolve a boundary to an "HH:MM" for today, or null when its sun time
       *  is unavailable. Re-reads the sun each call so re-arms track the day. */
      function resolveHHMM(b: Boundary): string | null {
        if (b.kind === "time") return isValidHHMM(b.time) ? b.time : null;
        const sun = ctx.helpers.getSunlight();
        const base = b.kind === "sunrise" ? sun.sunrise : sun.sunset;
        if (!isValidHHMM(base)) return null;
        return applyOffset(base, b.offset);
      }

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

      function schedule(
        timers: Map<number, ReturnType<typeof setTimeout>>,
        w: Window,
        b: Boundary,
        fire: (w: Window) => Promise<void>,
        tag: string,
      ): void {
        const existing = timers.get(w.index);
        if (existing) clearTimeout(existing);

        const hhmm = resolveHHMM(b);
        if (!hhmm) {
          // Sun time unavailable today — will be re-armed on `sunlight.changed`.
          const key = `${w.index}-${tag}`;
          if (!warnedNull.has(key)) {
            ctx.log(`Créneau ${w.index} : ${boundaryLabel(b)} indisponible aujourd'hui, borne ignorée`, "warn");
            warnedNull.add(key);
          }
          timers.delete(w.index);
          return;
        }
        warnedNull.delete(`${w.index}-${tag}`);

        const timer = setTimeout(() => {
          fire(w).catch((err) => ctx.logger.error({ err, slot: w.index }, `${tag} fire failed`));
          schedule(timers, w, b, fire, tag); // re-arm for the next day
          updateNextLabels();
        }, msUntilTime(hhmm));
        timers.set(w.index, timer);
      }

      function armAll(): void {
        for (const w of windows) {
          schedule(startTimers, w, w.start, fireOn, "start");
          schedule(endTimers, w, w.end, fireOff, "end");
        }
        updateNextLabels();
      }

      /** Re-resolve + re-arm boundaries that depend on the sun (their fire time
       *  shifts day to day). Fixed-time boundaries are left as-is. */
      function rearmSunBoundaries(): void {
        for (const w of windows) {
          if (w.start.kind !== "time") schedule(startTimers, w, w.start, fireOn, "start");
          if (w.end.kind !== "time") schedule(endTimers, w, w.end, fireOff, "end");
        }
        updateNextLabels();
      }

      function nextHHMM(boundaries: Boundary[]): string | null {
        const resolved = boundaries.map(resolveHHMM).filter(isValidHHMM);
        if (resolved.length === 0) return null;
        return resolved.sort((a, b) => msUntilTime(a) - msUntilTime(b))[0];
      }

      function updateNextLabels(): void {
        ctx.state.set("nextStart", windows.length ? nextHHMM(windows.map((w) => w.start)) : null);
        ctx.state.set("nextEnd", windows.length ? nextHHMM(windows.map((w) => w.end)) : null);
      }

      // ── Initialize ──

      ctx.state.set("status", "idle");
      ctx.state.set("currentSlot", null);
      armAll();

      const unsub = ctx.eventBus.onType("sunlight.changed", () => rearmSunBoundaries());

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
          unsub();
          // Leave equipments untouched (no forced OFF).
          ctx.state.set("status", "idle");
          ctx.state.set("currentSlot", null);
          ctx.log("Recette arrêtée");
        },
      };
    },
  };
}
