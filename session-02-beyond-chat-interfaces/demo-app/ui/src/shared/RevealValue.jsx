import React, { useState } from "react";
import { isIncidentalField } from "./incidental-fields.mjs";

export function RevealValue({ value, field, conceal, className = "", style }) {
  const [revealedValue, setRevealedValue] = useState(null);
  if (value == null || value === "Not reported") return <>{value ?? "Not reported"}</>;
  if (!(conceal ?? isIncidentalField(field, value))) return <span className={className} style={style}>{value}</span>;
  const revealed = revealedValue === value;
  const reveal = (event) => {
    event.stopPropagation();
    setRevealedValue(value);
  };
  return <span className={`incidental-value ${className}`} style={style}
    data-concealed={!revealed} role={revealed ? undefined : "button"}
    tabIndex={revealed ? undefined : 0} aria-label={revealed ? undefined : `Reveal ${field}`}
    onClick={reveal} onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); reveal(event); }
    }}>
    <span aria-hidden={!revealed}>{value}</span>
  </span>;
}
