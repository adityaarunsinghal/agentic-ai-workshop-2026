import React, { useEffect, useId, useRef } from "react";

export function Dialog({ title, subtitle, children, onClose, className = "" }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => {
      dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <div className="section-head modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p className="hint">{subtitle}</p>}
        </div>
        <button type="button" className="quiet" onClick={onClose} aria-label={`Close ${title}`}>Close</button>
      </div>
      {children}
    </dialog>
  );
}
