import React, { useMemo, useState } from "react";
import JsonView from "@uiw/react-json-view";
import { darkTheme } from "@uiw/react-json-view/dark";
import { lightTheme } from "@uiw/react-json-view/light";
import { Dialog } from "./Dialog.jsx";
import { inspectionDisplay } from "./code-display.mjs";
import { isIncidentalField } from "./incidental-fields.mjs";
import { RevealValue } from "./RevealValue.jsx";
import { correlatedExchange, isRunning } from "./execution.mjs";
import "../../code.css";

function incidentalValue(props, { type, value, keyName }) {
  if (type !== "value" || !isIncidentalField(keyName, value)) return undefined;
  return <RevealValue field={keyName} value={JSON.stringify(value)} conceal
    className={props.className} style={props.style} />;
}

export function JsonInspector({ value, expanded = false, label }) {
  const display = useMemo(() => inspectionDisplay(value), [value]);
  const [treeExpanded, setTreeExpanded] = useState(expanded);
  const theme = typeof document !== "undefined" &&
    getComputedStyle(document.documentElement).colorScheme === "light" ? lightTheme : darkTheme;
  return (
    <section className="json-inspector" aria-label="JSON inspector">
      <div className="json-view-options">
        {label && <p className="hint">{label}</p>}
        <button type="button" className="text-button" onClick={() => setTreeExpanded(!treeExpanded)}>
          {treeExpanded ? "Collapse tree" : "Expand tree"}
        </button>
      </div>
      <div className="json-tree" tabIndex={0} aria-label="Complete sanitized JSON tree"><JsonView
        key={String(treeExpanded)} value={display.tree}
        style={{ ...theme, backgroundColor: "transparent", fontSize: 12 }}
        collapsed={treeExpanded ? false : 1}
        displayDataTypes={false}
        enableClipboard={false}
        shortenTextAfterLength={Number.MAX_SAFE_INTEGER}
      >
        <JsonView.CountInfo render={(props, { value: item }) => display.parsedValues.has(item)
          ? <span {...props}>{props.children}<span className="json-parsed-string"># parsed JSON string</span></span>
          : undefined} />
        <JsonView.String render={incidentalValue} />
        <JsonView.Int render={incidentalValue} />
        <JsonView.Float render={incidentalValue} />
      </JsonView></div>
    </section>
  );
}

function CapturedValues({ values, missing }) {
  if (!values?.length) return <p className="hint" role="status">{missing}</p>;
  return <div className="captured-values">{values.map((entry, index) =>
    <JsonInspector key={`${entry.recordId}:${entry.field}:${index}`} value={entry.value}
      label={`${entry.kind} · ${entry.field}`} />
  )}</div>;
}

export function ExchangeInspector({ exchange }) {
  const input = exchange.request.http.length ? exchange.request.http : exchange.request.captured;
  const output = exchange.response.http.length ? exchange.response.http : exchange.response.body;
  const decisionField = (field) => exchange.decision[field].length ? exchange.decision[field]
    : input.filter((entry) => entry.value && Object.hasOwn(entry.value, field))
      .map((entry) => ({ ...entry, field: `${entry.field}.${field}`, value: entry.value[field] }));
  return <section className="exchange-inspector" aria-label="Correlated input and output">
    <div className="exchange-overview">
      <p className="hint">{exchange.boundary}</p>
      <p>Request {exchange.index} of {exchange.count}
        {exchange.final ? " · Final request in this run" : isRunning({ status: exchange.jobStatus }) ? " so far" : ""}</p>
    </div>
    <div className="exchange-pair">
      <section className="exchange-section" aria-label="Captured request">
        <h3>{exchange.request.http.length ? "HTTP request payload" : "Captured request payload"}</h3>
        {!exchange.request.http.length && <p className="hint">No HTTP request capture is available. This is the recorded gateway request.</p>}
        <CapturedValues values={input} missing="No request payload was captured for this operation." />
      </section>
      <section className="exchange-section" aria-label="Captured response">
        <h3>HTTP response</h3>
        <CapturedValues values={output} missing="No HTTP response body was captured for this operation." />
      </section>
    </div>
    {exchange.response.assistant.length > 0 && <section className="exchange-section" aria-label="Assembled assistant message">
      <h3>Assembled assistant message</h3>
      <CapturedValues values={exchange.response.assistant} />
    </section>}
    {exchange.kind === "decision" && <div className="exchange-pair">
      {[["state", "Typed state"], ["questions", "Typed questions"], ["answers", "Raw answers"]].map(([field, title]) =>
        <section className="exchange-section" key={field} aria-label={title}>
          <h3>{title}</h3>
          <CapturedValues values={decisionField(field)} missing={`${title} were not captured in a typed record.`} />
        </section>)}
    </div>}
    {exchange.relatedTools.length > 0 && <section className="exchange-section" aria-label="Related tool results">
      <h3>Tool results from this response</h3>
      <CapturedValues values={exchange.relatedTools} />
    </section>}
    {exchange.response.chunks.length > 0 && <details open={!output.length}>
      <summary>Captured provider chunks</summary>
      <JsonInspector value={exchange.response.chunks} />
    </details>}
    <details><summary>HTTP metadata and headers</summary>
      <JsonInspector value={{ transport: exchange.transport, requestHeaders: exchange.request.headers,
        responseHeaders: exchange.response.headers }} />
    </details>
    {exchange.limitations.length > 0 && <section className="exchange-section" role="status">
      <h3>Capture limitations</h3><JsonInspector value={exchange.limitations} />
    </section>}
    <details><summary>Correlation and original record references</summary>
      <p className="hint">This derived view joins captured fields by operation ID. Original records remain unchanged in Protocol.</p>
      <JsonInspector value={exchange} />
    </details>
  </section>;
}

export function RecordDialog({ record, title = "Record details", onClose, children, description }) {
  const exchange = correlatedExchange(record);
  const { exchange: _exchange, ...original } = exchange ? record : {};
  return (
    <Dialog title={title} onClose={onClose} className="record-dialog">
      {children}
      {description && <div className="section-head inspector-head">
        <p className="hint">{description}</p>
      </div>}
      {exchange ? <>
        <ExchangeInspector exchange={exchange} />
        <details><summary>Original selected record</summary><JsonInspector value={original} /></details>
      </> : <JsonInspector value={record} />}
    </Dialog>
  );
}
