/**
 * The browser observes authoritative state. Reconnection and inspection are
 * free reads; each user action has one identity and is posted at most once.
 */
import {
  ACTION_FIELDS,
  editableActionFields,
} from "../support/action-fields.mjs";
import { detectLanguage, highlightCode } from "./code-format.mjs";
import { isIncidentalField } from "./incidental-fields.mjs";
import { activityDuration, activityLabel, activityStatus, inspectionActivities } from "./execution-display.mjs";

const element = (id) => document.getElementById(id);
const markdown = window.markdownit({
  html: false, linkify: false,
  highlight: (text, language) => {
    const result = highlightCode(text, language);
    return `<pre class="code-surface"><code class="hljs">${result.html}</code></pre>`;
  },
});
markdown.renderer.rules.image = (tokens, index, options, env, renderer) =>
  markdown.utils.escapeHtml(
    renderer.renderInlineAsText(tokens[index].children, options, env),
  );
let applicationState = { revision: -1, chat: [], trace: [], queued: [] };
let refreshing = false,
  sourceNavigationMap,
  selectedConceptId,
  sourceOpener;
let selectedHarnessDimension = "control",
  selectedRequestFilter = null,
  sourceReadGeneration = 0;
let inspectionGeneration = 0,
  inspectionController,
  detailController,
  inspectionCursor = null,
  inspectionTitle = "Execution details",
  inspectionSequence = null,
  inspectionArchiveGeneration = null,
  clearingExecution = false,
  inspectionPageCursor = null,
  inspectionBusy = false,
  inspectionFailed = false,
  inspectionRefreshTimer,
  inspectionSearchTimer,
  inspectionLastRead = 0;
const inspectionRows = new Map();
let lastApprovalId = null,
  draftSession = null,
  lastUserPreferencesStatus = null;
let nearLatest = true,
  lastContentSignature = "";
let actionErrorMessage = null,
  invalidField = null,
  invalidValue = null,
  draftEdited = false;
const draftControls = [
  "control",
  "category",
  "count",
  "topic",
  "reviewer",
  "permission",
  "delay",
  "remember-topic",
];
const pendingActionTypes = new Set();
const messages = new Map(),
  briefings = new Map(),
  requests = new Map();
const dialogOpeners = new Map();
const mobile = matchMedia("(max-width: 760px)");
const dimensionNames = [
  ["control", "Control"],
  ["trigger", "Trigger"],
  ["authority", "Authority"],
  ["duration", "Duration"],
  ["tools", "Environment"],
  ["topology", "Topology"],
  ["memory", "Memory"],
  ["interface", "Interface"],
];
const text = (id, value) => {
  if (element(id).textContent !== value) element(id).textContent = value;
};
const node = (tag, className, value) => {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (value !== undefined) result.textContent = value;
  return result;
};
const renderedJson = new WeakMap();
/** JSON values stay exact; branches create their children only when expanded. */
function jsonTreeNode(value, key = null) {
  const label = () => key === null
    ? document.createTextNode("")
    : node("span", "json-key", `${JSON.stringify(key)}: `);
  if (value === null || typeof value !== "object") {
    const row = node("div", "json-tree-leaf");
    const type = value === null ? "null" : typeof value;
    const content = node("span", `json-${type}`, JSON.stringify(value) ?? String(value));
    if (isIncidentalField(key, value)) {
      const reveal = node("span", "incidental-value");
      reveal.dataset.concealed = "true";
      reveal.tabIndex = 0;
      reveal.setAttribute("role", "button");
      reveal.setAttribute("aria-label", `Reveal ${key}`);
      content.setAttribute("aria-hidden", "true");
      reveal.append(content);
      const show = (event) => {
        event.stopPropagation();
        reveal.dataset.concealed = "false";
        reveal.removeAttribute("role");
        reveal.removeAttribute("tabindex");
        reveal.removeAttribute("aria-label");
        content.removeAttribute("aria-hidden");
      };
      reveal.onclick = show;
      reveal.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(event); }
      };
      row.append(label(), reveal);
    } else row.append(label(), content);
    return { element: row };
  }
  const array = Array.isArray(value);
  const keys = Object.keys(value);
  if (!keys.length) {
    const row = node("div", "json-tree-leaf");
    row.append(label(), node("span", "json-collection", array ? "[]" : "{}"));
    return { element: row };
  }
  const branch = node("details", "json-tree-branch");
  const summary = node("summary");
  summary.append(label(), node("span", "json-collection",
    array ? `Array [${keys.length}]` : `Object {${keys.length}}`));
  const body = node("div", "json-tree-children");
  branch.append(summary, body);
  let children;
  const populate = () => {
    if (children) return;
    children = keys.map((name) => jsonTreeNode(value[name], array ? Number(name) : name));
    body.append(...children.map((child) => child.element));
  };
  branch.addEventListener("toggle", () => {
    if (branch.open) populate();
  });
  return {
    element: branch,
    expand() {
      populate();
      branch.open = true;
      for (const child of children) child.expand?.();
    },
    collapse() {
      branch.open = false;
      for (const child of children ?? []) child.collapse?.();
    },
  };
}
function jsonPanel(value) {
  const panel = node("section", "json-inspection");
  panel.setAttribute("aria-label", "JSON inspection");
  const controls = node("div", "json-tree-controls");
  const tree = node("div", "json-tree");
  tree.tabIndex = 0;
  tree.setAttribute("aria-label", "Complete JSON tree");
  const root = jsonTreeNode(value);
  tree.append(root.element);
  if (root.expand) {
    const expand = node("button", "text-button", "Expand tree");
    const collapse = node("button", "text-button", "Collapse tree");
    expand.type = collapse.type = "button";
    expand.onclick = () => root.expand();
    collapse.onclick = () => root.collapse();
    controls.append(expand, collapse);
  }
  const copy = node("button", "text-button", "Copy JSON");
  copy.type = "button";
  const status = node("span", "hint");
  status.setAttribute("role", "status");
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2) ?? "");
      status.textContent = "Copied";
    } catch {
      status.textContent = "Clipboard unavailable.";
    }
  };
  controls.append(copy, status);
  panel.append(controls, tree);
  return panel;
}
function renderJsonInto(id, value) {
  const target = element(id);
  const signature = JSON.stringify(value);
  if (renderedJson.get(target) === signature) return;
  renderedJson.set(target, signature);
  target.replaceChildren(jsonPanel(value));
}
function sourceLines(content, language) {
  const template = document.createElement("template");
  template.innerHTML = highlightCode(content, language).html;
  const lines = [document.createDocumentFragment()];
  function walk(item, scopes = []) {
    if (item.nodeType === Node.TEXT_NODE) {
      const pieces = item.textContent.split("\n");
      pieces.forEach((piece, index) => {
        if (index) lines.push(document.createDocumentFragment());
        if (piece) lines.at(-1).append(scopes.length
          ? node("span", scopes.join(" "), piece) : document.createTextNode(piece));
      });
    } else for (const child of item.childNodes)
      walk(child, item.nodeType === Node.ELEMENT_NODE ? [...scopes, ...item.classList] : scopes);
  }
  walk(template.content);
  return lines;
}
function showError(value) {
  element("error").hidden = !value;
  text("error", value || "");
}
function safeLink(label, url) {
  const link = node("a", "", label);
  try {
    const target = new URL(url);
    if (!["https:", "http:"].includes(target.protocol)) throw Error();
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  } catch {
    link.removeAttribute("href");
  }
  return link;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const response = await fetch("/api/state", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw Error("The visit is unavailable. Return to the portal.");
    snapshot(await response.json());
  } catch (error) {
    showError(actionErrorMessage || error.message);
    element("run").disabled = true;
  } finally {
    refreshing = false;
  }
}
function snapshot(next) {
  if (
    !Number.isSafeInteger(next.revision) ||
    next.revision <= applicationState.revision
  )
    return;
  applicationState = next;
  restoreDraft();
  render();
}
function change(kind, raw) {
  try {
    const data = JSON.parse(raw);
    if (!Number.isSafeInteger(data.revision)) throw Error("Invalid revision.");
    if (data.revision <= applicationState.revision) return;
    if (data.revision !== applicationState.revision + 1) {
      void refresh();
      return;
    }
    if (kind === "patch") Object.assign(applicationState, data.patch);
    else if (kind === "message") {
      if (data.index !== applicationState.chat.length)
        throw Error("Message gap.");
      applicationState.chat.push(data.message);
    } else if (kind === "message_update") {
      if (applicationState.chat[data.index]?.id !== data.message.id)
        throw Error("Message mismatch.");
      applicationState.chat[data.index] = data.message;
    } else if (kind === "text") {
      const message = applicationState.chat[data.index];
      if (
        !message ||
        message.text.length !== data.offset ||
        typeof data.text !== "string"
      )
        throw Error("Text gap.");
      message.text += data.text;
    } else if (kind === "execution") {
      applicationState.trace = data.trace;
      applicationState.execution = data.execution;
    }
    applicationState.revision = data.revision;
    restoreDraft();
    render();
  } catch {
    void refresh();
  }
}
function clearFieldError() {
  if (!invalidField) return;
  const control = element(ACTION_FIELDS[invalidField].id);
  control.removeAttribute("aria-invalid");
  const noticeId = `${control.id}-error`;
  const descriptions = (control.getAttribute("aria-describedby") || "")
    .split(" ")
    .filter((id) => id && id !== noticeId);
  if (descriptions.length)
    control.setAttribute("aria-describedby", descriptions.join(" "));
  else control.removeAttribute("aria-describedby");
  element(noticeId)?.remove();
  invalidField = null;
  invalidValue = null;
  actionErrorMessage = null;
  showError(applicationState.error);
}

function reportActionError(error) {
  actionErrorMessage = error.error || "The action was rejected.";
  showError(actionErrorMessage);
  const spec = Object.hasOwn(ACTION_FIELDS, error.field)
    ? ACTION_FIELDS[error.field]
    : null;
  if (!spec?.id) return;
  invalidField = error.field;
  const control = element(spec.id);
  invalidValue = control.type === "checkbox" ? control.checked : control.value;
  const noticeId = `${control.id}-error`;
  const notice = element(noticeId) || node("span", "hint");
  notice.id = noticeId;
  notice.setAttribute("role", "alert");
  notice.textContent = actionErrorMessage;
  control.after(notice);
  control.setAttribute("aria-invalid", "true");
  const descriptions = new Set(
    (control.getAttribute("aria-describedby") || "").split(" ").filter(Boolean),
  );
  descriptions.add(noticeId);
  control.setAttribute("aria-describedby", [...descriptions].join(" "));

  // Explore is outside the composer form, and all but one dimension is hidden.
  // Make the actual field reachable before focusing it, including a question
  // rejected by Schedule while its composer is behind the modal.
  const dimension = control.closest("section[data-dimension]");
  if (dimension) {
    selectedHarnessDimension = dimension.dataset.dimension;
    selectedBriefing = null;
    renderDimensions();
    if (!element("explore-dialog").open)
      openDialog("explore-dialog", document.activeElement);
  } else if (element("explore-dialog").open) {
    dialogOpeners.set("explore-dialog", control);
    element("explore-dialog").close();
  }
  control.focus();
  control.scrollIntoView({ block: "center" });
}

/** Reject before even allocating an action ID or issuing a status lookup. */
function preflight(type) {
  clearFieldError();
  for (const field of editableActionFields(type)) {
    const spec = ACTION_FIELDS[field],
      control = element(spec.id);
    const value =
      control.type === "checkbox"
        ? control.checked
        : control.type === "number"
          ? control.valueAsNumber
          : control.value;
    if (control.validity.badInput || !spec.valid(value)) {
      reportActionError({ field, error: spec.message });
      return false;
    }
  }
  return true;
}

/** A lost acknowledgement is resolved by lookup, never an automatic POST. */
async function action(type, data = {}) {
  if (pendingActionTypes.has(type) || !preflight(type)) return null;
  pendingActionTypes.add(type);
  const id = crypto.randomUUID();
  actionErrorMessage = null;
  showError(null);
  renderControls();
  try {
    const response = await fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ id, type, data }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await response.json();
    // A definite rejection already has its authoritative explanation. Lookup
    // is only for an uncertain response and must preserve the same guidance.
    if (!response.ok) {
      reportActionError(result);
      return null;
    }
    return result;
  } catch (error) {
    let rejected = { error: error.message };
    try {
      const response = await fetch(`/api/action?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const known = await response.json();
      if (known.status === "accepted") return known.result;
      if (known.status === "rejected" && known.error) rejected = known;
    } catch {
      /* Keep the original uncertainty visible. */
    }
    reportActionError(rejected);
    return null;
  } finally {
    await refresh();
    // Keep the composer locked until acknowledgement recovery and its state
    // refresh finish; its submit handler has not yet retired the sent draft.
    pendingActionTypes.delete(type);
    renderControls();
  }
}
function options() {
  return {
    control: element("control").value,
    category: element("category").value,
    count: Number(element("count").value),
    topic: element("topic").value,
    reviewer: element("reviewer").checked,
    permission: element("permission").value,
  };
}
function canQueue() {
  return Boolean(
    applicationState.activeId &&
    applicationState.briefing?.id === applicationState.activeId &&
    applicationState.briefing?.options.control === "agent" &&
    applicationState.phase !== "reviewing",
  );
}
function composerPending() {
  return ["run", "steer", "follow_up"].some((type) =>
    pendingActionTypes.has(type),
  );
}
function renderControls() {
  const ready =
    applicationState.model &&
    !["initializing", "setup", "readiness"].includes(applicationState.phase) &&
    !(Date.parse(applicationState.expiresAt) <= Date.now());
  const busy = Boolean(applicationState.activeId),
    queuing = canQueue();
  const mode = queuing ? element("delivery").value : "run";
  const remaining =
    (applicationState.limits?.requestsPerVisit ?? 20) -
    (applicationState.requestsUsed ?? 0);
  const queued = applicationState.queued?.some(
    (item) => item.type === mode && item.status === "queued",
  );
  element("run").disabled =
    !ready ||
    (busy && !queuing) ||
    composerPending() ||
    queued ||
    remaining < (mode === "run" && element("reviewer").checked ? 2 : 1);
  text("run", queuing ? (mode === "steer" ? "Steer" : "Follow up") : "Ask");
  text(
    "prompt-label",
    busy
      ? "Add input while the agent works"
      : "What would you like to find on HN?",
  );
  element("queue").hidden = !queuing;
  text(
    "delivery-hint",
    mode === "follow_up"
      ? "Follow-up waits for ordinary work to finish."
      : "Steering waits for the current tools to finish.",
  );
  element("stop").hidden = !busy;
  for (const id of ["stop", "explore-stop"])
    element(id).disabled = !busy || pendingActionTypes.has("stop");
  element("new-conversation").disabled =
    busy || !ready || pendingActionTypes.has("new_conversation");
  element("schedule").disabled =
    !ready ||
    applicationState.scheduled?.status === "scheduled" ||
    pendingActionTypes.has("schedule");
  element("cancel-schedule").hidden =
    applicationState.scheduled?.status !== "scheduled";
  element("cancel-schedule").disabled =
    pendingActionTypes.has("cancel_schedule");
  element("remember").disabled =
    busy ||
    !applicationState.userPreferences?.loaded ||
    pendingActionTypes.has("remember");
  element("refresh").disabled = busy || pendingActionTypes.has("refresh");
  element("check-saved-change").disabled =
    busy || pendingActionTypes.has("refresh");
  // These are next-briefing controls; changing them never rewrites recorded settings.
  for (const button of document.querySelectorAll("[data-save]"))
    button.disabled =
      busy ||
      !applicationState.userPreferences?.loaded ||
      pendingActionTypes.has("save_links");
  element("resume").disabled =
    !ready ||
    busy ||
    !applicationState.resume?.available ||
    pendingActionTypes.has("resume");
  element("check-recovery").disabled =
    busy || pendingActionTypes.has("check_recovery");
}
function restoreDraft() {
  if (
    !applicationState.sessionId ||
    draftSession === applicationState.sessionId
  )
    return;
  const firstLoad = draftSession === null;
  draftSession = applicationState.sessionId;
  // A new conversation keeps the in-memory edits. A reconnect restores only
  // before the visitor has edited this page, and supports older text-only drafts.
  if (!firstLoad || draftEdited) {
    saveDraft();
    return;
  }
  try {
    const saved = JSON.parse(
      sessionStorage.getItem(`harness-draft:${draftSession}`) || "null",
    );
    if (saved && !element("prompt").value) {
      element("prompt").value = saved.text;
      element("delivery").value = saved.delivery || "steer";
      for (const id of draftControls) {
        const value = saved.settings?.[id];
        if (id === "reviewer") {
          if (typeof value === "boolean") element(id).checked = value;
        } else if (typeof value === "string") element(id).value = value;
      }
    }
  } catch {
    /* A blocked browser store still leaves the in-memory draft intact. */
  }
}
function saveDraft() {
  if (!draftSession) return;
  try {
    sessionStorage.setItem(
      `harness-draft:${draftSession}`,
      JSON.stringify({
        text: element("prompt").value,
        delivery: element("delivery").value,
        // Numeric strings stay raw: blank, fractional and out-of-range drafts
        // remain editable and never acquire a default or a clamped value.
        settings: Object.fromEntries(
          draftControls.map((id) => [
            id,
            id === "reviewer" ? element(id).checked : element(id).value,
          ]),
        ),
      }),
    );
  } catch {
    showError(
      "This browser cannot retain your draft across reloads. Copy it before leaving.",
    );
  }
}
function render() {
  const contentSignature = `${applicationState.chat.map((m) => `${m.id}:${m.text.length}`).join("|")}:${JSON.stringify(applicationState.cards)}:${applicationState.approval?.id}`;
  const changed = contentSignature !== lastContentSignature;
  lastContentSignature = contentSignature;
  element("fixture").hidden = !applicationState.fixture;
  element("local-mode").hidden = applicationState.runtimeMode !== "local";
  element("development-mode").hidden = applicationState.runtimeMode !== "development";
  if (applicationState.runtimeMode === "development")
    text(
      "development-mode",
      `Local workshop development${applicationState.fundingMode ? ` · ${applicationState.fundingMode} funding` : ""}. The workshop selects the model and pricing profile. Code runs on this computer.`,
    );
  if (["fixture", "local", "development"].includes(applicationState.runtimeMode))
    text(
      "execution-boundary",
      "Pi-mini is an educational subset of Pi 1.0.0. This local process runs with your computer's permissions.",
    );
  text(
    "requests",
    `${applicationState.requestsUsed ?? 0} / ${applicationState.limits?.requestsPerVisit ?? 20} request attempts`,
  );
  text(
    "model",
    applicationState.model
      ? `${applicationState.model.id}${applicationState.model.profileId ? ` · ${applicationState.model.profileId}` : ""}`
      : "Workshop connection unavailable",
  );
  text(
    "allowance",
    applicationState.usage
      ? `Portal snapshot: $${applicationState.usage.availableUsd} available · ${applicationState.usage.unsettledRequests} unsettled`
      : "",
  );
  text(
    "phase",
    applicationState.phase === "idle"
      ? applicationState.lastOutcome
        ? `Ready · last activity ${applicationState.lastOutcome.status}`
        : "Ready"
      : applicationState.phase,
  );
  text(
    "scope",
    applicationState.briefing
      ? `${applicationState.briefing.trigger === "schedule" ? "Scheduled" : "Manual"} briefing`
      : "",
  );
  if (actionErrorMessage || applicationState.error)
    showError(actionErrorMessage || applicationState.error);
  renderMessages();
  renderCards();
  renderUserPreferences();
  renderApproval();
  renderRequestStatus();
  renderDimensions();
  renderTrace();
  renderQueue();
  const schedule = applicationState.scheduled;
  text(
    "schedule-status",
    schedule
      ? `${schedule.status} · ${new Date(schedule.dueAt).toLocaleTimeString()}${schedule.error ? ` · ${schedule.error}` : ""}`
      : "",
  );
  text(
    "visit-expiry",
    applicationState.expiresAt
      ? `Visit ends ${new Date(applicationState.expiresAt).toLocaleString()}.`
      : "Visit expiry unavailable.",
  );
  renderControls();
  if (
    changed &&
    (!nearLatest ||
      element("prompt").getBoundingClientRect().bottom > innerHeight + 100)
  )
    element("jump-latest").hidden = false;
}
function briefingRecords() {
  return Array.isArray(applicationState.briefings)
    ? applicationState.briefings
    : Object.values(applicationState.briefings ?? {});
}
function briefingNode(id) {
  if (briefings.has(id)) return briefings.get(id);
  const section = node("section", "briefing");
  section.dataset.briefing = id;
  const head = node("div", "briefing-head");
  const label = node("p", "hint", `Briefing ${briefings.size + 1}`);
  const settings = node(
    "button",
    "text-button briefing-settings",
    "Recorded settings",
  );
  settings.type = "button";
  settings.onclick = () => {
    selectedBriefing = id;
    openDialog("explore-dialog", settings);
    renderDimensions();
  };
  head.append(label, settings);
  const chat = node("div", "briefing-messages"),
    cards = node("div", "briefing-cards");
  section.append(head, chat, cards);
  element("chat").append(section);
  const value = { section, chat, cards, label, settings, signature: null };
  briefings.set(id, value);
  return value;
}
let selectedBriefing = null;
function renderMessages() {
  element("welcome").hidden = applicationState.chat.length > 0;
  for (const message of applicationState.chat) {
    const belongsToBriefing =
      message.briefingId &&
      (message.role !== "status" ||
        briefings.has(message.briefingId) ||
        briefingRecords().some((record) => record.id === message.briefingId));
    const container = belongsToBriefing
      ? briefingNode(message.briefingId).chat
      : element("chat");
    let item = messages.get(message.id);
    if (!item) {
      const article = node("article", `message ${message.role}`),
        label = node("span", "message-role"),
        body = node("div");
      article.append(label, body);
      container.append(article);
      item = { article, label, body, text: null };
      messages.set(message.id, item);
    }
    item.article.hidden = !message.text;
    item.label.textContent =
      ({
        user: "You",
        producer: "Agent",
        reviewer: "Reviewer",
        status: "Application",
      }[message.role] || message.role) +
      (message.complete === false ? " · Partial response" : "");
    if (item.text === message.text) continue;
    item.text = message.text;
    if (message.role === "status") item.body.textContent = message.text;
    else item.body.innerHTML = markdown.render(message.text);
    for (const link of item.body.querySelectorAll("a")) {
      link.rel = "noopener noreferrer";
      link.target = "_blank";
    }
  }
}
function renderCards() {
  const records = briefingRecords();
  if (
    applicationState.briefing &&
    !records.some((record) => record.id === applicationState.briefing.id)
  )
    records.push({
      ...applicationState.briefing,
      cards: applicationState.cards,
      sources: applicationState.sources,
    });
  for (const record of records) {
    const group = briefingNode(record.id);
    group.record = record;
    const outcome = record.outcome?.status ?? record.status;
    group.label.textContent = `${record.trigger === "schedule" ? "Scheduled briefing" : "Briefing"}${outcome ? ` · ${outcome}` : ""}`;
    const cards = record.cards?.length ? record.cards : (record.sources ?? []);
    const signature = JSON.stringify(cards);
    if (group.signature === signature) continue;
    group.signature = signature;
    const children = cards.length
      ? [
          node(
            "h4",
            "cards-heading",
            record.cards?.length ? "Recommended links" : "Observed HN links",
          ),
        ]
      : [];
    cards.forEach((card, index) => {
      const article = node("article", "source-card"),
        content = node("div");
      const heading = node("h4");
      heading.append(safeLink(card.title, card.canonicalUrl));
      const meta = node(
        "span",
        "source-meta",
        `HN ${card.upstreamId} · ${card.evidenceLevel} · ${new Date(card.retrievedAt).toLocaleTimeString()}`,
      );
      content.append(heading, meta);
      if (card.note) content.append(node("p", "", card.note));
      const save = node("button", "quiet", "Save to reading list");
      save.type = "button";
      save.dataset.save = card.id;
      save.onclick = () => action("save_links", { sourceIds: [card.id] });
      content.append(save);
      article.append(
        node("span", "card-number", String(index + 1).padStart(2, "0")),
        content,
      );
      children.push(article);
    });
    group.cards.replaceChildren(...children);
  }
}
function renderUserPreferences() {
  const userPreferences = applicationState.userPreferences;
  if (!userPreferences) return;
  text(
    "user-preferences-status",
    `${userPreferences.status}${userPreferences.error ? ` · ${userPreferences.error}` : ""}`,
  );
  text(
    "saved-topic",
    userPreferences.value?.preferences.topic
      ? `Saved interest: ${userPreferences.value.preferences.topic}`
      : "No saved interest.",
  );
  const savedSignature = JSON.stringify(userPreferences.value?.entries ?? []);
  if (element("saved-links").dataset.signature !== savedSignature) {
    element("saved-links").dataset.signature = savedSignature;
    element("saved-links").replaceChildren(
      ...(userPreferences.value?.entries ?? []).map((record) => {
        const item = node("li");
        item.append(safeLink(record.title, record.canonicalUrl));
        return item;
      }),
    );
  }
  element("pending-save").hidden = !userPreferences.pending;
  renderJsonInto("pending-save-data", userPreferences.pending ?? null);
  const visible = Boolean(
    userPreferences.pending ||
    userPreferences.error ||
    userPreferences.status === "saved",
  );
  element("save-status").hidden = !visible;
  if (
    lastUserPreferencesStatus !== userPreferences.status ||
    userPreferences.pending ||
    userPreferences.error
  )
    text(
      "save-status",
      userPreferences.pending
        ? "user-preferences save is unconfirmed. The proposed change is retained."
        : userPreferences.error || "user-preferences saved.",
    );
  lastUserPreferencesStatus = userPreferences.status;
}
function renderApproval() {
  const approval = applicationState.approval;
  element("approval").hidden = !approval;
  if (!approval) return;
  if (lastApprovalId !== approval.id) {
    lastApprovalId = approval.id;
    element("allow-run").checked = false;
  }
  // Approval does not steal focus from a draft, source inspector or earlier text.
  text("approval-summary", approval.summary);
  text(
    "approval-preference",
    typeof approval.args?.topic === "string"
      ? `Interest: ${approval.args.topic || "(clear saved interest)"}`
      : "",
  );
  const signature = JSON.stringify(approval.preview ?? []);
  if (element("approval-links").dataset.signature !== signature) {
    element("approval-links").dataset.signature = signature;
    element("approval-links").replaceChildren(
      ...(approval.preview ?? []).map((source) => {
        const item = node("li");
        item.append(safeLink(source.title, source.canonicalUrl));
        return item;
      }),
    );
  }
  renderJsonInto("approval-data", {
    tool: approval.tool, arguments: approval.args,
    userPreferencesRevision: approval.etag, expiresAt: approval.expiresAt,
  });
  const expired = Date.parse(approval.expiresAt) <= Date.now();
  text(
    "approval-expiry",
    expired
      ? "Approval expired. No write authorized."
      : `Expires ${new Date(approval.expiresAt).toLocaleTimeString()}`,
  );
  element("approve").disabled = element("deny").disabled =
    expired || pendingActionTypes.has("approve");
}
function recoveryOperationId() {
  return (
    applicationState.recovery?.operationId ??
    applicationState.resume?.operationId ??
    applicationState.recoveryOperationId
  );
}

/** Automatic provider work stays quiet; show a status when the visitor can act. */
function renderRequestStatus() {
  const recovery =
    applicationState.recoverySupported === true
      ? applicationState.recovery
      : null;
  const resume = applicationState.resume;
  const failed =
    !applicationState.activeId &&
    applicationState.lastOutcome?.status === "failed";
  const partial = applicationState.chat.some(
    (message) =>
      message.briefingId === applicationState.briefing?.id &&
      message.complete === false &&
      message.text,
  );
  const phase = recovery?.phase;
  const pendingUserPreferences =
    !applicationState.activeId &&
    Boolean(applicationState.userPreferences?.pending);
  const expired = Date.parse(applicationState.expiresAt) <= Date.now();
  const cancelled =
    !applicationState.activeId &&
    applicationState.lastOutcome?.status === "cancelled";
  const show =
    expired ||
    pendingUserPreferences ||
    (!applicationState.activeId && ["failed", "cancelled"].includes(phase)) ||
    failed ||
    cancelled ||
    (!applicationState.activeId && resume?.available);
  element("recovery").hidden = !show;
  if (!show) return;
  let title = "Request ended";
  let reason = "";
  if (pendingUserPreferences) title = "user-preferences save is unconfirmed.";
  else if (cancelled || phase === "cancelled") title = "Request stopped";
  else if (failed || phase === "failed")
    title = partial
      ? "Response interrupted. Partial work is retained."
      : "This request could not finish.";
  if (pendingUserPreferences)
    reason = "Check the saved change before continuing.";
  else if (!applicationState.activeId && recovery?.usage.unsettledRequests > 0)
    reason = "Billing confirmation is pending. Check status before continuing.";
  else if (!applicationState.activeId && resume && !resume.available)
    reason = resume.reason || "This checkpoint is unavailable.";
  else if (!applicationState.activeId)
    reason =
      recovery?.failure?.message || applicationState.lastOutcome?.message || "";
  if (expired) {
    title = "This workshop visit has ended.";
    reason =
      "Your available work remains readable. Return to the portal to start a new visit.";
  }
  text("recovery-title", title);
  text("recovery-reason", reason);
  element("resume").hidden =
    !resume?.available || Boolean(applicationState.activeId);
  element("check-saved-change").hidden = !pendingUserPreferences;
  element("check-recovery").hidden =
    applicationState.recoverySupported !== true ||
    !recoveryOperationId() ||
    Boolean(applicationState.activeId) ||
    Boolean(
      recovery &&
      !["running", "retry_wait"].includes(recovery.phase) &&
      recovery.usage.unsettledRequests === 0,
    );
  element("edit-question").hidden =
    Boolean(applicationState.activeId) ||
    !applicationState.chat.some((message) => message.role === "user");
}
function renderQueue() {
  const signature = JSON.stringify(applicationState.queued ?? []);
  if (element("queued").dataset.signature === signature) return;
  element("queued").dataset.signature = signature;
  element("queued").replaceChildren(
    ...(applicationState.queued ?? []).map((item) =>
      node(
        "li",
        "",
        `${item.type === "steer" ? "Steering" : "Follow-up"} · ${item.status}: ${item.text}`,
      ),
    ),
  );
}
function renderDimensions() {
  const record = selectedBriefing
    ? briefings.get(selectedBriefing)?.record
    : applicationState.briefing;
  const setting =
    record?.options ?? record?.settings ?? applicationState.defaults ?? {};
  const values = {
    control:
      setting.control === "fixed"
        ? "Application chooses the sequence."
        : "Model chooses tool steps.",
    trigger:
      record?.trigger === "schedule"
        ? "Scheduled once."
        : "A visitor's request.",
    authority:
      (record?.effectivePermission ?? setting.permission) === "allow"
        ? "user-preferences writes allowed for this briefing."
        : "user-preferences writes need approval.",
    duration: "Runs in the active visit, with Stop and reconnect.",
    tools: `HN metadata, the briefing skill and the visitor user-preferences.${setting.category ? ` Listing: ${setting.category}, up to ${setting.count} stories.` : ""}`,
    topology: setting.reviewer
      ? "Producer, then a separate reviewer."
      : "One agent.",
    memory: `Conversation plus saved interests.${setting.topic ? ` Briefing topic: ${setting.topic}.` : ""}`,
    interface:
      "Task, source cards, approvals, execution and source inspection.",
  };
  if (!element("dimensions").children.length)
    for (const [id, title] of dimensionNames) {
      const button = node("button", "dimension", title);
      button.type = "button";
      button.dataset.dimension = id;
      button.onclick = () => {
        selectedHarnessDimension = id;
        renderDimensions();
      };
      element("dimensions").append(button);
    }
  for (const button of element("dimensions").children)
    button.setAttribute(
      "aria-current",
      String(button.dataset.dimension === selectedHarnessDimension),
    );
  for (const section of document.querySelectorAll("section[data-dimension]"))
    section.hidden = section.dataset.dimension !== selectedHarnessDimension;
  text(
    "effective-settings",
    record
      ? `Recorded settings for briefing ${record.id.slice(0, 8)}${record.status ? ` · ${record.status}` : ""}`
      : "No briefing yet. Controls below apply to the next request.",
  );
  text(
    "dimension-value",
    `${record ? "Recorded behavior" : "Default behavior"}: ${values[selectedHarnessDimension]}`,
  );
}
/** Group compact observations. Full records never enter applicationState. */
function groupTrace() {
  const groups = new Map();
  const activity = {
    id: "activity",
    entries: [],
    title: "Harness activity",
  };
  groups.set("activity", activity);
  for (const [index, entry] of (applicationState.execution?.requests ?? []).entries()) {
    if (!entry) continue;
    groups.set(entry.operationId, {
      id: entry.operationId,
      start: entry,
      entries: [],
      title: `Request ${index + 1}`,
    });
  }
  for (const entry of [...(applicationState.trace ?? [])].sort(
    (a, b) => a.sequence - b.sequence,
  )) {
    // Protocol lifecycle rows remain available in the paged inspector.
    if (
      ![
        "tool_execution_start",
        "mcp.request_start",
        "app.approval_requested",
        "app.approval_decision",
        "app.approval_ended",
        "app.permission",
        "app.hn_observation",
        "app.skill_loaded",
        "app.fixed_source_call",
        "app.input_queued",
        "app.input_archived",
        "app.input_rejected",
        "app.user_preferences_saved",
        "app.user_preferences_recovered",
        "app.context_rejected",
        "app.cancel_requested",
        "app.action_rejected",
        "app.recovery_status_unavailable",
        "app.scheduled",
        "app.schedule_failed",
        "app.schedule_cancelled",
        "execution.capture_error",
        "app.setup_failed",
        "app.user_preferences_error",
      ].includes(entry.type) &&
      !(
        ["agent_end", "app.briefing_end"].includes(entry.type) &&
        ["failed", "cancelled"].includes(entry.status)
      )
    )
      continue;
    if (entry.operationId && !groups.has(entry.operationId)) {
      groups.set(entry.operationId, {
        id: entry.operationId,
        entries: [],
        title: "Request activity",
      });
    }
    const group = groups.get(entry.operationId) || activity;
    group.entries.push(entry);
  }
  return groups;
}
function renderTrace() {
  const canClear = applicationState.execution?.clearSupported === true;
  element("execution-clear").hidden = !canClear;
  element("execution-clear").disabled = !canClear || clearingExecution;
  const canSort = applicationState.execution?.sortSupported === true;
  element("execution-order-field").hidden = !canSort;
  element("execution-order").disabled = !canSort;
  const groups = groupTrace();
  const visible = new Set();
  const count = applicationState.execution?.requests?.length ?? 0;
  for (const group of groups.values()) {
    if (!group.start && !group.entries.length) continue;
    visible.add(group.id);
    let item = requests.get(group.id);
    if (!item) {
      const section = node("section", "request-step"),
        button = node("button", "request-button");
      button.type = "button";
      const title = node("strong"),
        meta = node("span"),
        tools = node("ul", "request-tools"),
        outcome = node("p", "request-outcome");
      button.append(title, meta);
      section.append(button, tools, outcome);
      element("trace").append(section);
      button.onclick = () => {
        inspectExecution(
          group.id === "activity" ? "all" : group.id,
          group.title,
          button,
        );
      };
      item = { section, button, title, meta, tools, outcome };
      requests.set(group.id, item);
    }
    const isActive =
      group.start?.status === "running" &&
      applicationState.activeId === group.start.taskId;
    item.section.classList.toggle("active", isActive);
    item.title.textContent = group.title;
    item.meta.textContent = group.start
      ? [`Model${group.start.requestKind ? ` · ${group.start.requestKind}` : ""}`,
          new Date(group.start.startedAt ?? group.start.at).toLocaleTimeString(),
          activityDuration(group.start)].filter(Boolean).join(" · ")
      : "Observed operations";
    const toolSignature = JSON.stringify(group.entries);
    if (item.tools.dataset.signature !== toolSignature) {
      item.tools.dataset.signature = toolSignature;
      const old = new Map([...item.tools.children].map((row) => [row.dataset.record, row]));
      const kept = new Set();
      for (const entry of group.entries) {
        let row = old.get(String(entry.id));
        if (!row) {
          row = node("li");
          row.dataset.record = entry.id;
          const button = node("button", "trace-operation");
          button.type = "button";
          button.onclick = () => inspectExecution(entry.id, activityLabel(entry), button);
          row.append(button);
          item.tools.append(row);
        }
        row.firstElementChild.textContent = [
          executionRole(entry), activityLabel(entry), activityStatus(entry.status), activityDuration(entry),
        ].filter(Boolean).join(" · ");
        kept.add(String(entry.id));
      }
      for (const [id, row] of old) if (!kept.has(id)) row.remove();
    }
    const status = isActive ? "In progress" : activityStatus(group.start?.status);
    if (item.outcome.textContent !== status) item.outcome.textContent = status;
  }
  for (const [id, item] of requests)
    if (!visible.has(id)) {
      item.section.remove();
      requests.delete(id);
    }
  text(
    "execution-summary",
    count
      ? `${count} model ${count === 1 ? "request" : "requests"} · ${applicationState.activeId ? "Activity running" : activityStatus(applicationState.lastOutcome?.status) || "Recorded activity"}`
      : "Requests and source operations appear here.",
  );
  text(
    "open-execution",
    `View execution${count ? ` · ${count} requests` : ""}`,
  );
  const capture = applicationState.execution?.capture;
  text(
    "execution-capture",
    capture?.status === "partial"
      ? `Some diagnostic details could not be captured. ${capture.reason ?? ""} Application work can continue.`
      : "",
  );
  scheduleInspectionRefresh();
}
/** The model chooses; tools execute; the harness coordinates and checks. */
function executionRole(entry) {
  return {
    user: "User",
    model: "Model",
    tool: "Tool",
    harness: "Harness",
  }[entry.actor] ?? "Harness";
}

function inspectExecution(filter, title, opener) {
  clearTimeout(inspectionSearchTimer);
  inspectionSearchTimer = null;
  selectedRequestFilter = filter;
  inspectionTitle = title;
  element("execution-query").value = "";
  element("execution-query").disabled = filter !== "all";
  element("execution-query-field").hidden = filter !== "all";
  element("execution-scope").hidden = filter === "all";
  text("execution-scope-label", title);
  openDialog("request-dialog", opener);
  void loadInspection();
}

async function clearExecutionLogs() {
  if (applicationState.execution?.clearSupported !== true || clearingExecution || !window.confirm(
    "Clear all execution logs for this visit? Archived details will be removed. " +
    "Your conversation, preferences, funding and current task are kept. New activity can create new logs.",
  )) return;
  clearingExecution = true;
  clearTimeout(inspectionRefreshTimer);
  clearTimeout(inspectionSearchTimer);
  inspectionRefreshTimer = inspectionSearchTimer = null;
  element("execution-more").open = false;
  element("execution-clear").disabled = true;
  inspectionGeneration++;
  inspectionController?.abort();
  detailController?.abort();
  text("execution-load-status", "Clearing execution logs…");
  try {
    const response = await fetch("/api/execution/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      redirect: "error",
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    const { revision, ...summary } = await response.json();
    if (!response.ok) throw Error(summary.error || "Execution logs could not be cleared.");
    inspectionGeneration++;
    inspectionController?.abort();
    detailController?.abort();
    // Do not advance the SSE revision: unseen conversation events still apply.
    if (revision >= applicationState.revision) {
      applicationState.trace = [];
      applicationState.execution = summary;
      renderTrace();
    }
    selectedRequestFilter = "all";
    inspectionTitle = "Execution details";
    inspectionCursor = null;
    inspectionSequence = null;
    element("execution-query").value = "";
    element("execution-query").disabled = false;
    element("execution-query-field").hidden = false;
    element("execution-scope").hidden = true;
    element("execution-pagination").hidden = true;
    inspectionRows.clear();
    element("request-data").replaceChildren();
    await refresh();
    if (element("request-dialog").open) await loadInspection();
  } catch (error) {
    inspectionFailed = true;
    text("execution-load-status", `${error.message} Retry reading the list to check its contents.`);
    element("execution-retry").hidden = false;
  } finally {
    clearingExecution = false;
    element("execution-clear").disabled = applicationState.execution?.clearSupported !== true;
  }
}

function scheduleInspectionRefresh() {
  const sequence = applicationState.execution?.latestSequence;
  const archiveChanged = inspectionArchiveGeneration !== null &&
    applicationState.execution?.generation != null &&
    applicationState.execution.generation !== inspectionArchiveGeneration;
  if (!element("request-dialog").open || clearingExecution || inspectionBusy ||
      (inspectionFailed && !archiveChanged) || inspectionSearchTimer || inspectionRefreshTimer ||
      (!archiveChanged && (inspectionSequence === null || sequence == null || sequence === inspectionSequence))) return;
  inspectionRefreshTimer = setTimeout(() => {
    inspectionRefreshTimer = null;
    const reset = inspectionArchiveGeneration !== null &&
      applicationState.execution?.generation != null &&
      applicationState.execution.generation !== inspectionArchiveGeneration;
    if (!element("request-dialog").open || clearingExecution || inspectionBusy ||
        (inspectionFailed && !reset)) return;
    void loadInspection(reset ? undefined : inspectionPageCursor, { background: !reset });
  }, Math.max(0, 1000 - (Date.now() - inspectionLastRead)));
}

/** Refresh summaries in place. Only an explicit open reads a full record. */
async function loadInspection(cursor, { background = false } = {}) {
  clearTimeout(inspectionRefreshTimer);
  inspectionRefreshTimer = null;
  inspectionController?.abort();
  if (!background) {
    detailController?.abort();
    inspectionRows.clear();
    element("request-data").replaceChildren();
    element("execution-pagination").hidden = !cursor;
    element("execution-next").hidden = true;
    element("execution-first").hidden = !cursor;
  }
  inspectionController = new AbortController();
  const generation = ++inspectionGeneration;
  inspectionBusy = true;
  inspectionFailed = false;
  inspectionLastRead = Date.now();
  inspectionPageCursor = cursor ?? null;
  inspectionCursor = null;
  element("execution-next").disabled = true;
  element("execution-retry").hidden = true;
  text("request-title", "Execution");
  if (!background) text("execution-load-status", "Loading activities…");
  const query =
    selectedRequestFilter === "all"
      ? element("execution-query").value.trim()
      : selectedRequestFilter;
  const view = element("execution-view").value;
  const params = new URLSearchParams({
    view,
    limit: "40",
    ...(applicationState.execution?.sortSupported === true
      ? { order: element("execution-order").value } : {}),
    ...(query ? { query } : {}),
    ...(cursor ? { cursor } : {}),
  });
  try {
    const response = await fetch(`/api/execution?${params}`, {
      cache: "no-store",
      signal: AbortSignal.any([
        inspectionController.signal,
        AbortSignal.timeout(15000),
      ]),
    });
    if (!response.ok) throw Error("Execution records are unavailable.");
    const page = await response.json();
    if (generation !== inspectionGeneration || !element("request-dialog").open)
      return;
    inspectionCursor = page.nextCursor;
    inspectionSequence =
      page.summary?.latestSequence ?? applicationState.execution?.latestSequence ?? 0;
    inspectionArchiveGeneration =
      page.summary?.generation ?? applicationState.execution?.generation ?? null;
    const displayed = renderInspection(page.records, { preserve: background, view });
    element("execution-next").disabled = false;
    element("execution-next").hidden = !page.nextCursor;
    element("execution-first").hidden = !inspectionPageCursor;
    element("execution-pagination").hidden = !inspectionPageCursor && !page.nextCursor;
    const singlePage = !inspectionPageCursor && !page.nextCursor &&
      (page.total == null || page.total === page.records.length);
    const noun = view === "teaching" ? (displayed.activities === 1 ? "activity" : "activities")
      : (displayed.activities === 1 ? "record" : "records");
    const activityCount = `${displayed.activities} ${noun}`;
    const counts = singlePage
      ? activityCount + (displayed.activities === page.records.length ? "" : ` · ${page.records.length} matching records`)
      : `${activityCount} shown · ${page.records.length} records on this page${page.total == null ? "" : ` · ${page.total} records in scope`}`;
    text("execution-load-status", page.records.length
      ? counts + (displayed.retained ? ` · ${displayed.retained} open or focused row retained` : "")
      : displayed.retained ? "No matching records on this page. The open or focused row is retained." : "No matching activity.");
  } catch (error) {
    if (generation === inspectionGeneration && error.name !== "AbortError") {
      inspectionFailed = true;
      text("execution-load-status", error.message);
      element("execution-retry").hidden = false;
    }
  } finally {
    if (generation === inspectionGeneration) {
      inspectionBusy = false;
      scheduleInspectionRefresh();
    }
  }
}

function renderInspection(entries, { preserve = false, view = "teaching" } = {}) {
  const activities = inspectionActivities(entries, view);
  const container = element("request-data");
  const focused = document.activeElement;
  const anchor = [...inspectionRows.values()].find((item) => item.details.contains(focused))?.details ??
    [...inspectionRows.values()].find((item) => item.details.open)?.details;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const keys = new Set(activities.map((activity) => activity.key));
  let retained = 0;
  for (const [key, item] of inspectionRows) {
    if (keys.has(key)) continue;
    if (preserve && (item.details.open || item.details.contains(focused))) {
      retained++;
      item.meta.textContent = `${item.metadata} · Retained while open or focused`;
    } else {
      item.controller?.abort();
      item.details.remove();
      inspectionRows.delete(key);
    }
  }
  let position = container.firstElementChild;
  for (const activity of activities) {
    const entry = activity.record;
    let item = inspectionRows.get(activity.key);
    if (!item) {
      const details = node("details", "trace-entry");
      const badge = node("span", "trace-badge");
      const label = node("span");
      const meta = node("span", "trace-entry-meta");
      const summary = node("summary");
      summary.append(badge, label, meta);
      const body = node("div");
      const actions = node("div", "trace-entry-actions");
      const outcome = node("button", "text-button", "Load outcome record");
      outcome.type = "button";
      actions.append(outcome);
      details.append(summary, actions, body);
      item = { details, badge, label, meta, body, outcome, activity };
      const current = item;
      outcome.onclick = () => void loadExecutionRecord(
        current.activity.outcomeId ?? current.fullOutcomeId, details, body, current,
      );
      details.addEventListener("toggle", (event) => {
        if (event.target !== details) return;
        if (!details.open) {
          current.controller?.abort();
          body.replaceChildren();
          return;
        }
        for (const other of inspectionRows.values())
          if (other !== current && other.details.open) other.details.open = false;
        void loadExecutionRecord(current.activity.record.id, details, body, current);
      });
      inspectionRows.set(activity.key, item);
    }
    item.activity = activity;
    item.details.dataset.event = entry.id;
    item.badge.textContent = executionRole(entry);
    item.badge.dataset.role = entry.actor;
    item.label.textContent = activityLabel(entry);
    const at = new Date(entry.startedAt ?? entry.at);
    item.metadata = [
      activityStatus(entry.status), activityDuration(entry),
      Number.isFinite(at.getTime()) ? at.toLocaleTimeString() : "",
      view === "protocol" ? entry.type ?? entry.kind : "",
    ].filter(Boolean).join(" · ");
    item.meta.textContent = item.metadata;
    item.outcome.hidden = !(activity.outcomeId ?? item.fullOutcomeId);
    if (item.details !== position) container.insertBefore(item.details, position);
    position = item.details.nextElementSibling;
  }
  if (preserve && focused?.isConnected && document.activeElement !== focused)
    focused.focus({ preventScroll: true });
  if (preserve && anchor?.isConnected)
    element("request-dialog").scrollTop += anchor.getBoundingClientRect().top - anchorTop;
  return { activities: activities.length, retained };
}

async function loadExecutionRecord(id, details, body, item) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  item.controller = controller;
  body.replaceChildren(node("p", "hint", "Loading full record…"));
  try {
    const response = await fetch(`/api/execution/${encodeURIComponent(id)}`, {
      cache: "no-store",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
    });
    const { record } = await response.json();
    if (!response.ok || !record)
      throw Error("This record is unavailable. Refresh the list and try again.");
    if (controller.signal.aborted || !details.open || !body.isConnected) return;
    body.replaceChildren(jsonPanel(record));
    item.fullOutcomeId = record.endRecordId;
    item.outcome.hidden = !(item.activity.outcomeId ?? item.fullOutcomeId);
  } catch (error) {
    if (controller.signal.aborted || !details.open || !body.isConnected) return;
    body.replaceChildren(node("p", "hint", error.message));
    const retry = node("button", "quiet", "Retry read");
    retry.type = "button";
    retry.onclick = () => void loadExecutionRecord(id, details, body, item);
    body.append(retry);
  }
}
function openDialog(id, opener) {
  if (id === "request-dialog") element("request-data").replaceChildren();
  dialogOpeners.set(id, opener);
  if (!element(id).open) element(id).showModal();
}
function returnDialogFocus(dialog, opener) {
  // Native close already restores focus synchronously. Its later close event
  // must not steal focus from a validation field or a new edit in the meantime.
  const focused = document.activeElement;
  if (
    !dialog.open &&
    (focused === document.body ||
      focused === dialog ||
      dialog.contains(focused))
  )
    opener?.focus({ preventScroll: true });
}
function placeExecution() {
  const target = mobile.matches
    ? element("execution-drawer")
    : element("execution-home");
  target.append(element("execution-panel"));
  if (!mobile.matches && element("execution-dialog").open)
    element("execution-dialog").close();
}
async function openSource(id, opener) {
  try {
    sourceNavigationMap ??= await (await fetch("/api/sources")).json();
    selectedConceptId = sourceNavigationMap.concepts.find(
      (concept) => concept.id === id,
    );
    if (!selectedConceptId) throw Error("This source mapping is unavailable.");
    sourceOpener = opener;
    text("source-title", selectedConceptId.title);
    text(
      "source-difference",
      selectedConceptId.difference ||
        "Pi-mini is a documented teaching subset. The original file is preserved in full.",
    );
    element("source-dialog").showModal();
    await showSource("local");
  } catch (error) {
    showError(error.message);
  }
}
async function showSource(which) {
  const generation = ++sourceReadGeneration,
    target = selectedConceptId[which];
  const response = await fetch(
    `/api/source?path=${encodeURIComponent(target.path)}`,
  );
  if (!response.ok) throw Error("The source file is unavailable.");
  const content = await response.text();
  if (generation !== sourceReadGeneration) return;
  text("source-path", `${target.path} · line ${target.line}`);
  const lines = sourceLines(content, detectLanguage(target.path)).map((line, index) => {
    const row = node("div", "code-line");
    if (index + 1 === target.line) row.classList.add("selected");
    const source = node("span", "line-content hljs");
    source.append(line);
    row.append(
      node("span", "line-number", String(index + 1)),
      source,
    );
    return row;
  });
  element("source-code").replaceChildren(...lines);
  element("source-code").scrollTop = Math.max(0, (target.line - 5) * 20.4);
}

// One persistent composer handles run, steering and follow-up delivery.
element("ask").onsubmit = async (event) => {
  event.preventDefault();
  if (element("run").disabled) return;
  const submitted = element("prompt").value;
  const type = canQueue() ? element("delivery").value : "run";
  const data =
    type === "run"
      ? {
          text: submitted,
          sessionId: applicationState.sessionId,
          options: options(),
        }
      : { briefingId: applicationState.activeId, text: submitted };
  const result = await action(type, data);
  if (result?.accepted && element("prompt").value === submitted) {
    element("prompt").value = "";
    saveDraft();
  }
};
element("prompt").addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing &&
    event.keyCode !== 229
  ) {
    event.preventDefault();
    element("ask").requestSubmit();
  }
});
for (const id of ["prompt", "delivery", ...draftControls]) {
  const edited = () => {
    draftEdited = true;
    const control = element(id);
    const value = control.type === "checkbox" ? control.checked : control.value;
    // A blur can deliver a delayed change event for the same invalid value.
    if (ACTION_FIELDS[invalidField]?.id === id && value !== invalidValue)
      clearFieldError();
    saveDraft();
  };
  element(id).addEventListener("input", edited);
  element(id).addEventListener("change", edited);
}
element("delivery").onchange = () => {
  saveDraft();
  renderControls();
};
element("example").onclick = () => {
  clearFieldError();
  draftEdited = true;
  element("prompt").value =
    "Suggest up to three HN links worth opening for someone building agents. Explain your choices from the available metadata.";
  saveDraft();
  element("prompt").focus();
};
for (const id of ["stop", "explore-stop"])
  element(id).onclick = () =>
    action("stop", { briefingId: applicationState.activeId });
element("new-conversation").onclick = () => action("new_conversation");
element("schedule").onclick = () =>
  action("schedule", {
    text: element("prompt").value,
    delaySeconds: Number(element("delay").value),
    options: options(),
  });
element("cancel-schedule").onclick = () => action("cancel_schedule");
element("remember").onclick = async () => {
  const result = await action("remember", {
    topic: element("remember-topic").value,
  });
  if (result?.accepted) element("explore-dialog").close();
};
element("refresh").onclick = () => action("refresh");
element("reviewer").onchange = renderControls;
for (const [id, accepted] of [
  ["approve", true],
  ["deny", false],
])
  element(id).onclick = async () => {
    const result = await action("approve", {
      approvalId: applicationState.approval.id,
      accepted,
      allowForRun: accepted && element("allow-run").checked,
    });
    if (result && !applicationState.approval)
      element("prompt").focus({ preventScroll: true });
  };
element("resume").onclick = () =>
  action("resume", {
    briefingId: applicationState.resume.briefingId,
    checkpointId: applicationState.resume.checkpointId,
  });
element("check-recovery").onclick = () =>
  action("check_recovery", { operationId: recoveryOperationId() });
// The same free readback used by user-preferences Reload acknowledges the original
// saved tool result. It does not need inference status or dispatch another write.
element("check-saved-change").onclick = () => action("refresh");
element("edit-question").onclick = () => {
  // Never overwrite a newer draft. The original input is already in the task.
  if (!element("prompt").value)
    element("prompt").value =
      [...applicationState.chat]
        .reverse()
        .find((message) => message.role === "user")?.text || "";
  saveDraft();
  element("prompt").focus();
  element("prompt").scrollIntoView({ block: "center" });
};
element("explore").onclick = () => {
  selectedBriefing = null;
  renderDimensions();
  openDialog("explore-dialog", element("explore"));
};
element("open-execution").onclick = () =>
  openDialog("execution-dialog", element("open-execution"));
element("activity-details").onclick = () => {
  inspectExecution("all", "Execution details", element("activity-details"));
};
element("execution-retry").onclick = reloadInspection;
element("execution-first").onclick = () => void loadInspection();
element("execution-next").onclick = () => void loadInspection(inspectionCursor);
element("execution-clear").onclick = () => void clearExecutionLogs();
function reloadInspection() {
  clearTimeout(inspectionSearchTimer);
  inspectionSearchTimer = null;
  void loadInspection();
}
element("execution-view").onchange = reloadInspection;
element("execution-order").onchange = reloadInspection;
element("execution-query").oninput = () => {
  clearTimeout(inspectionSearchTimer);
  inspectionSearchTimer = setTimeout(() => {
    inspectionSearchTimer = null;
    void loadInspection();
  }, 300);
};
element("execution-search").onsubmit = (event) => {
  event.preventDefault();
  reloadInspection();
};
element("execution-all").onclick = () =>
  inspectExecution("all", "Execution details", element("execution-all"));
element("request-dialog").addEventListener("close", () => {
  clearTimeout(inspectionRefreshTimer);
  clearTimeout(inspectionSearchTimer);
  inspectionRefreshTimer = inspectionSearchTimer = null;
  inspectionGeneration++;
  inspectionController?.abort();
  detailController?.abort();
  inspectionBusy = false;
  inspectionFailed = false;
  inspectionSequence = null;
  inspectionArchiveGeneration = null;
  inspectionRows.clear();
  element("request-data").replaceChildren();
});
for (const name of ["explore", "execution", "request"]) {
  element(`close-${name}`).onclick = () => element(`${name}-dialog`).close();
  element(`${name}-dialog`).addEventListener("close", () =>
    returnDialogFocus(
      element(`${name}-dialog`),
      dialogOpeners.get(`${name}-dialog`),
    ),
  );
}
element("dimension-source").onclick = () =>
  openSource(selectedHarnessDimension, element("dimension-source"));
element("request-source").onclick = () =>
  openSource("context", element("request-source"));
element("tool-source").onclick = () =>
  openSource("tools", element("tool-source"));
element("close-source").onclick = () => element("source-dialog").close();
element("source-dialog").addEventListener("close", () =>
  returnDialogFocus(element("source-dialog"), sourceOpener),
);
element("local-source").onclick = () =>
  showSource("local").catch((error) => showError(error.message));
element("original-source").onclick = () =>
  showSource("original").catch((error) => showError(error.message));
element("jump-latest").onclick = () => {
  element("prompt").scrollIntoView({
    block: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
  });
  element("jump-latest").hidden = true;
};
window.addEventListener(
  "scroll",
  () => {
    nearLatest =
      element("prompt").getBoundingClientRect().bottom <= innerHeight + 100;
    if (nearLatest) element("jump-latest").hidden = true;
  },
  { passive: true },
);
mobile.addEventListener("change", placeExecution);
placeExecution();
// Native EventSource reconnects only a free GET. Countdown ticks never dispatch.
const events = new EventSource("/api/events");
events.addEventListener("snapshot", (event) => {
  try {
    snapshot(JSON.parse(event.data));
  } catch {
    void refresh();
  }
});
for (const kind of ["patch", "message", "message_update", "text", "execution"])
  events.addEventListener(kind, (event) => change(kind, event.data));
for (const kind of ["resync", "error"])
  events.addEventListener(kind, () => void refresh());
window.addEventListener("pagehide", () => {
  clearTimeout(inspectionRefreshTimer);
  clearTimeout(inspectionSearchTimer);
  inspectionController?.abort();
  detailController?.abort();
  saveDraft();
  events.close();
});
void refresh();
setInterval(refresh, 2000);
setInterval(() => {
  renderRequestStatus();
  renderApproval();
  renderControls();
}, 500);
