import React from "react";

const phases = new Set(["run", "audit", "research", "experiment", "evaluate", "keep", "revert", "stop",
  "repair", "format_repair", "format_invalid", "format_recovered", "evaluation_invalid"]);
const field = (record, key) => record[key] ?? record.payload?.[key];
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const comparable = (value) => typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const list = (value) => Array.isArray(value) ? value : [];
const verdicts = new Set(["supported", "contradicted", "unresolved", "qualified", "omitted"]);

export function autoResearchPhase(record) {
  const kind = String(record?.kind ?? record?.type ?? "");
  const phase = kind.startsWith("auto_research.") ? kind.slice("auto_research.".length) : "";
  return phases.has(phase) ? phase : null;
}

function measures(value, prefix = "", depth = 0) {
  if (!object(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (comparable(item)) return [[name, item]];
    return depth < 1 && object(item) ? measures(item, name, depth + 1) : [];
  });
}

export function evaluationComparison(record) {
  const baseline = field(record, "baselineEvaluation") ?? record.result?.baseline;
  const candidate = field(record, "candidateEvaluation") ?? record.result?.candidate;
  const rubric = field(record, "rubric");
  const claims = list(baseline?.claims).flatMap((claim) => {
    const next = list(candidate?.claims).find((item) => item.id === claim.id);
    if (!claim.id || !verdicts.has(claim.verdict) || !verdicts.has(next?.verdict)) return [];
    return [{
      key: `Claim ${claim.id}`, label: list(rubric?.claims).find((item) => item.id === claim.id)?.text,
      baseline: claim.verdict, candidate: next.verdict,
    }];
  });
  const goals = list(baseline?.goals).flatMap((goal) => {
    const next = list(candidate?.goals).find((item) => item.id === goal.id);
    if (!goal.id || typeof goal.met !== "boolean" || typeof next?.met !== "boolean") return [];
    return [{
      key: `Goal ${goal.id}`, label: list(rubric?.goals).find((item) => item.id === goal.id)?.question,
      baseline: goal.met ? "met" : "not met", candidate: next.met ? "met" : "not met",
    }];
  });
  const added = Array.isArray(baseline?.addedClaims) && Array.isArray(candidate?.addedClaims)
    ? [...new Set([...baseline.addedClaims, ...candidate.addedClaims].map((claim) => claim.id))]
      .flatMap((id) => {
        const before = baseline.addedClaims.find((claim) => claim.id === id);
        const after = candidate.addedClaims.find((claim) => claim.id === id);
        if (!id || (before && !verdicts.has(before.verdict)) || (after && !verdicts.has(after.verdict))) return [];
        return [{
          key: `Added claim ${id}`, label: after?.text ?? before?.text,
          baseline: before?.verdict ?? "not present", candidate: after?.verdict ?? "not present",
        }];
      }) : [];
  const before = new Map(measures(baseline));
  return [...claims, ...goals, ...added, ...measures(candidate)
    .filter(([key, value]) => before.has(key) && typeof before.get(key) === typeof value)
    .map(([key, candidate]) => ({ key, baseline: before.get(key), candidate }))];
}

const wordCount = (copy) => typeof copy?.body === "string"
  ? (copy.body.trim().match(/\S+/gu) ?? []).length : null;
const sourceCount = (copy) => Array.isArray(copy?.sourceIds) ? new Set(copy.sourceIds).size : null;
const excerpt = (value, limit) => typeof value === "string"
  ? value.length > limit ? `${value.slice(0, limit)}…` : value : "";
const comparisonStyle = {
  display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 18rem), 1fr))",
  gap: "1rem", marginBlock: "1rem", overflowWrap: "anywhere",
};

function CopyComparison({ before, candidate }) {
  if (!object(before) || !object(candidate) ||
    (before.body === candidate.body && before.headline === candidate.headline &&
      JSON.stringify(before.sourceIds) === JSON.stringify(candidate.sourceIds))) return null;
  return <details>
    <summary>Compare before and candidate</summary>
    <div style={comparisonStyle}>
      {[["Before", before], ["Candidate", candidate]].map(([label, copy]) => <section key={label} aria-label={label}>
        <h4>{label}</h4>
        {typeof copy.headline === "string" && <p><strong>{excerpt(copy.headline, 180)}</strong></p>}
        {typeof copy.body === "string" && <p>{excerpt(copy.body, 480)}</p>}
        <p className="hint">
          {wordCount(copy) !== null ? `${wordCount(copy)} body words` : "Body not reported"}
          {sourceCount(copy) !== null ? ` · ${sourceCount(copy)} cited sources` : ""}
          {copy.body?.length > 480 || copy.headline?.length > 180 ? " · excerpt" : ""}
        </p>
      </section>)}
    </div>
  </details>;
}

export function AutoResearchRecord({ record }) {
  const phase = autoResearchPhase(record);
  if (!phase || record.captureIncomplete) return null;
  if (["repair", "format_repair", "format_invalid", "format_recovered", "evaluation_invalid"].includes(phase))
    return <p className="hint">{phase === "format_recovered" ? "The repaired response passed validation."
      : ["repair", "format_repair"].includes(phase) ? "One format-only request using the same frozen inputs and remaining run allowance."
        : "Unusable response; no Keep or Revert. The current copy and last valid metrics are preserved."}</p>;
  if (phase === "experiment") return <CopyComparison
    before={field(record, "before")} candidate={field(record, "candidate") ?? record.result} />;
  if (phase === "evaluate") {
    const comparisons = evaluationComparison(record);
    if (!comparisons.length) return null;
    // Changed verdicts and lost/preserved reader goals are more useful than a
    // made-up overall score. Keep matching by frozen IDs, never array position.
    const visible = [...comparisons.filter((row) => row.baseline !== row.candidate),
      ...comparisons.filter((row) => row.baseline === row.candidate)].slice(0, 8);
    return <div className="editorial-receipts execution-table-scroll" style={{ marginBlock: "1rem" }}>
      <table>
        <caption>Recorded evaluation against the same rubric</caption>
        <thead><tr><th>Measure</th><th>Baseline</th><th>Candidate</th></tr></thead>
        <tbody>{visible.map(({ key, label, baseline, candidate }) => <tr key={key}>
          <th scope="row">{key}{label && <small>{excerpt(label, 120)}</small>}</th>
          <td>{String(baseline)}</td><td>{String(candidate)}</td>
        </tr>)}</tbody>
      </table>
      {comparisons.length > 8 && <p className="hint">8 comparable measures, changes first; the complete evaluations are in the record.</p>}
    </div>;
  }
  if (["keep", "revert", "stop"].includes(phase)) {
    const reason = field(record, "reason");
    return typeof reason === "string" && reason.trim()
      ? <p className="hint"><strong>{phase === "stop" ? "Stopping condition" : "Decision reason"}: </strong>{excerpt(reason, 600)}</p>
      : null;
  }
  return null;
}
