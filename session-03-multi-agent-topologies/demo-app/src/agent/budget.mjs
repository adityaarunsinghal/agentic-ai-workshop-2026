import { ResearchError } from "./policy.mjs";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// Windows refuses to open a directory handle for fsync. Only those codes are
// tolerated, and only on win32; any other ledger failure still stops inference.
function directorySyncUnsupported(error) {
  return ["EPERM", "EISDIR", "EACCES"].includes(error?.code);
}

function dollars(value) {
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)) value = Number(value);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function reportedCost(usage) {
  for (const value of [usage?.cost, usage?.cost_usd, usage?.total_cost, usage?.knownCostUsd]) {
    const cost = dollars(value);
    if (cost !== null) return cost;
  }
  return null;
}

/**
 * One admission budget for every inference kind. Missing charge information
 * retains its reservation; SDK token-price estimates never settle a charge.
 */
export function createInferenceBudget({ config, trace, fixture }) {
  const maximum = dollars(config.maxInferenceCostUsd ?? 1);
  if (maximum === null || maximum > 1000)
    throw new ResearchError("CONFIG", "maxInferenceCostUsd must be a nonnegative USD amount up to 1000.");
  const entries = new Map();
  const finalAllowances = new Map();
  const ledgerFile = config.inferenceLedgerFile;
  let ledgerError = null, savedLedger = false;
  const unavailable = () => new ResearchError("BUDGET_STORAGE",
    "Inference accounting could not be saved or restored. Editing remains available; new model requests are stopped.");
  function persist() {
    if (!ledgerFile) return;
    let file;
    try {
      mkdirSync(dirname(ledgerFile), { recursive: true, mode: 0o700 });
      file = openSync(`${ledgerFile}.next`, "w", 0o600);
      writeFileSync(file, JSON.stringify({
        schemaVersion: "session2.inference.v1", issueId: config.issueId,
        operations: [...entries.values()], updatedAt: new Date().toISOString(),
      }) + "\n");
      fsyncSync(file);
      closeSync(file); file = undefined;
      renameSync(`${ledgerFile}.next`, ledgerFile);
      // The reservation is durable before the gateway can dispatch inference.
      // Windows cannot open a directory for fsync (EPERM/EISDIR); NTFS journals
      // the rename itself, so the fsynced file plus rename is already durable there.
      try {
        file = openSync(dirname(ledgerFile), "r");
        fsyncSync(file);
      } catch (error) {
        if (process.platform !== "win32" || !directorySyncUnsupported(error)) throw error;
      }
      savedLedger = true;
    } catch {
      ledgerError = unavailable();
      throw ledgerError;
    } finally { if (file !== undefined) closeSync(file); }
  }
  try {
    if (ledgerFile && existsSync(ledgerFile)) {
      const value = JSON.parse(readFileSync(ledgerFile, "utf8"));
      if (value.schemaVersion !== "session2.inference.v1" ||
        value.issueId !== config.issueId || !Array.isArray(value.operations))
        throw unavailable();
      for (const operation of value.operations) {
        if (typeof operation.operationId !== "string" || entries.has(operation.operationId) ||
          dollars(operation.reservationUsd) === null || typeof operation.settled !== "boolean" ||
          (operation.settled && dollars(operation.costUsd) === null))
          throw unavailable();
        entries.set(operation.operationId, {
          operationId: operation.operationId, model: operation.model, kind: operation.kind,
          ...(typeof operation.profileId === "string" ? { profileId: operation.profileId } : {}),
          reservationUsd: dollars(operation.reservationUsd), boundKnown: operation.boundKnown === true,
          settled: operation.settled, costUsd: operation.settled ? dollars(operation.costUsd) : null,
        });
      }
      savedLedger = true;
    }
  } catch { ledgerError = unavailable(); }
  if (!savedLedger && config.initialInferenceHistoryUnavailable)
    ledgerError = unavailable();
  // Only migration reads legacy diagnostic records. New accounting never
  // depends on log retention, paging, filtering, or an inspector connection.
  const legacy = savedLedger || ledgerError ? []
    : config.initialInferenceEntries ?? (ledgerFile ? [] : trace.entries ?? []);
  for (const record of legacy) {
    // Older records used the request kind as the event kind.
    const reservation = record.kind === "inference.reserved" ||
      (record.settled === false && typeof record.boundKnown === "boolean" && record.payloadBytes !== undefined);
    if (reservation && record.operationId) {
      const reservationUsd = dollars(record.reservationUsd);
      if (reservationUsd === null)
        ledgerError = unavailable();
      if (ledgerError) break;
      entries.set(record.operationId, {
        operationId: record.operationId, model: record.model, kind: record.requestKind ?? record.kind,
        reservationUsd, boundKnown: record.boundKnown, settled: false, costUsd: null,
      });
    } else if (record.kind === "inference.settlement") {
      const entry = entries.get(record.operationId);
      const costUsd = dollars(record.costUsd);
      if (entry && costUsd !== null) {
        entry.costUsd = costUsd;
        entry.settled = true;
      }
    }
  }
  if (!savedLedger && !ledgerError && ledgerFile) {
    try { persist(); } catch { /* Read-only editor state remains usable. */ }
  }
  const summary = () => {
    const operations = [...entries.values()];
    const knownCostUsd = operations.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
    const reservedUsd = operations.reduce((total, entry) =>
      total + (entry.settled ? 0 : entry.reservationUsd), 0);
    const finalAnswerReservedUsd = [...finalAllowances.values()].reduce((total, hold) => total + (hold.amount ?? 0), 0);
    return {
      maxInferenceCostUsd: maximum,
      knownCostUsd: ledgerError ? null : knownCostUsd,
      reservedUsd: ledgerError ? null : reservedUsd,
      finalAnswerReservedUsd,
      remainingUsd: ledgerError ? 0 : Math.max(0, maximum - knownCostUsd - reservedUsd - finalAnswerReservedUsd),
      unsettledOperations: operations.filter((entry) => !entry.settled).map((entry) => entry.operationId),
      simulated: fixture, accountingAvailable: !ledgerError,
      ...(ledgerError ? { error: ledgerError.message } : {}),
    };
  };
  function protectFinal(ownerId, model) {
    if (ledgerError) throw ledgerError;
    if (fixture) return;
    const supplied = config.inferenceCostBounds?.[model] ?? config.maxRequestCostUsd;
    const amount = supplied === undefined ? null : dollars(supplied);
    if (supplied !== undefined && amount === null)
      throw new ResearchError("CONFIG", "Inference cost bounds must be nonnegative USD amounts.");
    if (amount !== null && (amount <= 0 || amount > summary().remainingUsd))
      throw new ResearchError("COST_LIMIT", "There is insufficient allowance to reserve this story's final response.");
    finalAllowances.set(ownerId, { amount });
    trace.record("inference.final_reserved", { ownerId, amountUsd: amount, priceBoundKnown: amount !== null, budget: summary() });
  }
  function releaseFinal(ownerId) {
    if (!finalAllowances.delete(ownerId)) return;
    trace.record("inference.final_released", { ownerId, budget: summary() });
  }
  // The broker enforces a per-request minimum reservation (bootstrap
  // minimumRequestUsd). A configured maxRequestCostUsd below that floor would
  // reserve less than the broker charges and under-count the ceiling, so the
  // gateway supplies the resolved floor and every bound is raised to it. Fixture
  // and local (OpenRouter, no broker minimum) leave the floor at zero.
  let requestFloorUsd = 0;
  function setRequestFloor(amount) {
    const floor = dollars(amount);
    requestFloorUsd = floor === null ? 0 : floor;
  }
  function requestBound(model) {
    const configured = config.inferenceCostBounds?.[model] ?? config.maxRequestCostUsd;
    const supplied = configured === undefined ? undefined : dollars(configured);
    if (configured !== undefined && supplied === null)
      throw new ResearchError("CONFIG", "Inference cost bounds must be nonnegative USD amounts.");
    const base = supplied === undefined ? summary().remainingUsd : supplied;
    if (base === null)
      throw new ResearchError("CONFIG", "Inference cost bounds must be nonnegative USD amounts.");
    // Raise a known bound to the broker's per-request floor so the reservation and
    // the price bound sent to the broker never fall below what it will charge.
    const bound = fixture ? base : Math.max(base, requestFloorUsd);
    return { bound, supplied };
  }
  function canReserve(model) {
    if (ledgerError) throw ledgerError;
    const { bound } = requestBound(model);
    return fixture || (bound > 0 && bound <= summary().remainingUsd);
  }
  function reserve(operationId, { model, profileId, kind, payload, ownerId, final }) {
    if (ledgerError) throw ledgerError;
    if (entries.has(operationId))
      throw new ResearchError("OPERATION_REUSE", "This inference operation already has a reservation.");
    if (final) releaseFinal(ownerId);
    if (kind !== "story" && [...finalAllowances.values()].some((hold) => hold.amount === null))
      throw new ResearchError("FINAL_RESERVE", "Editorial inference waits while an active story's final-response price bound is unknown.");
    const available = summary().remainingUsd;
    const { bound, supplied } = requestBound(model);
    if (!fixture && (available <= 0 || bound <= 0 || bound > available)) {
      const current = summary();
      throw new ResearchError("COST_LIMIT",
        `The app's $${maximum.toFixed(2)} inference limit has insufficient free allowance. ` +
        `$${current.knownCostUsd.toFixed(4)} is recorded usage, $${current.reservedUsd.toFixed(4)} awaits settlement, ` +
        `and $${current.finalAnswerReservedUsd.toFixed(4)} is reserved for final responses. No model request was sent.`);
    }
    const entry = {
      operationId, model, kind, reservationUsd: fixture ? 0 : bound,
      ...(typeof profileId === "string" ? { profileId } : {}),
      boundKnown: supplied !== undefined, settled: false, costUsd: null,
    };
    entries.set(operationId, entry);
    persist();
    const { kind: requestKind, ...reservation } = entry;
    trace.record("inference.reserved", { ...reservation, requestKind, budget: summary(), payloadBytes: Buffer.byteLength(JSON.stringify(payload)) });
    return entry.reservationUsd;
  }
  function settle(operationId, cost) {
    const entry = entries.get(operationId);
    if (!entry) return;
    const amount = fixture ? 0 : dollars(cost);
    if (amount !== null) {
      entry.costUsd = amount;
      entry.settled = true;
    }
    persist();
    trace.record("inference.settlement", {
      operationId, status: entry.settled ? "settled" : "charge-unavailable",
      costUsd: entry.costUsd, reservationUsd: entry.reservationUsd,
      budget: summary(),
    });
    if (summary().knownCostUsd > maximum)
      throw new ResearchError("COST_LIMIT", "Reported inference charges exceed the configured ceiling. Further inference is blocked.");
  }
  return {
    reserve, canReserve, settle, summary, protectFinal, releaseFinal, setRequestFloor,
    get pending() { return [...entries.values()].filter((entry) => !entry.settled).map((entry) => ({ ...entry })); },
  };
}
