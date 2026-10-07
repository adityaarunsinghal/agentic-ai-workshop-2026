/**
 * The browser observes authoritative state. Reconnection and inspection are
 * free reads; each user action has one identity and is posted at most once.
 */
import {
  ACTION_FIELDS,
  editableActionFields,
} from "../support/action-fields.mjs";

const element = (id) => document.getElementById(id);
const markdown = window.markdownit({ html: false, linkify: false });
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
    } else if (kind === "trace") applicationState.trace.push(data.entry);
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
  text(
    "pending-save-data",
    userPreferences.pending
      ? JSON.stringify(userPreferences.pending, null, 2)
      : "",
  );
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
  text(
    "approval-data",
    JSON.stringify(
      {
        tool: approval.tool,
        arguments: approval.args,
        userPreferencesRevision: approval.etag,
        expiresAt: approval.expiresAt,
      },
      null,
      2,
    ),
  );
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
    [...applicationState.trace]
      .reverse()
      .find(
        (entry) =>
          entry.type === "app.request_start" &&
          entry.briefingId === applicationState.resume?.briefingId,
      )?.operationId
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
/**
 * Keep operational updates in authoritative state and system diagnostics.
 * The teaching view retains full request payloads, repeated schemas and IDs.
 * Project only event metadata; source observations and model content stay exact.
 */
function executionTrace() {
  return applicationState.trace
    .filter(
      (entry) =>
        !["app.recovery", "app.recovery_status_unavailable"].includes(
          entry.type,
        ),
    )
    .map(({ recovery, recoverySupported, ...entry }) => {
      if (entry.outcome) {
        const { recovery: status, ...outcome } = entry.outcome;
        entry.outcome = outcome;
      }
      return entry;
    });
}

/** Group the teaching projection while retaining every delivery of a request. */
function groupTrace() {
  const groups = new Map(),
    current = new Map();
  const activity = {
    id: "activity",
    entries: [],
    title: "Application activity",
  };
  groups.set("activity", activity);
  for (const entry of executionTrace()) {
    const owner = `${entry.briefingId}:${entry.role || entry.actor || "producer"}`;
    if (entry.type === "app.request_start") {
      // A cached response can be delivered again under the same operation.
      // Keep its first start and all prior delivery events together.
      if (!groups.has(entry.operationId))
        groups.set(entry.operationId, {
          id: entry.operationId,
          entries: [],
          start: entry,
          title: `Request ${groups.size}`,
        });
      // The latest delivery is active until its own end event arrives.
      groups.get(entry.operationId).end = null;
      current.set(owner, entry.operationId);
      current.set(`${entry.briefingId}:latest`, entry.operationId);
    }
    const id =
      entry.operationId ||
      current.get(owner) ||
      (entry.type.startsWith("app.")
        ? current.get(`${entry.briefingId}:latest`)
        : null);
    const group = groups.get(id) || activity;
    group.entries.push(entry);
    if (entry.type === "app.request_end") group.end = entry;
  }
  return groups;
}
function renderTrace() {
  const groups = groupTrace();
  let count = 0;
  for (const group of groups.values()) {
    if (!group.start) continue;
    count++;
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
        selectedRequestFilter = group.id;
        openDialog("request-dialog", button);
        renderInspection();
      };
      item = { section, button, title, meta, tools, outcome };
      requests.set(group.id, item);
    }
    const isActive =
      !group.end && applicationState.activeId === group.start.briefingId;
    item.section.classList.toggle("active", isActive);
    item.title.textContent = `Request ${count}`;
    item.meta.textContent = `${group.start.role || "producer"} · ${new Date(group.start.at).toLocaleTimeString()}`;
    const tools = group.entries.filter(
      (e) => e.type === "tool_execution_start",
    );
    const toolSignature = JSON.stringify(tools.map((e) => e.id));
    if (item.tools.dataset.signature !== toolSignature) {
      item.tools.dataset.signature = toolSignature;
      item.tools.replaceChildren(
        ...tools.map((e) => node("li", "", e.toolName)),
      );
    }
    const stopReason = [...group.entries]
      .reverse()
      .find((e) => e.type === "message_end" && e.message?.role === "assistant")
      ?.message.stopReason;
    const status =
      group.end?.status === "failed"
        ? "Request failed · inspect details"
        : group.end
          ? stopReason === "toolUse"
            ? "Response with tools"
            : stopReason === "stop"
              ? "Response complete"
              : group.end.status
          : isActive
            ? "In progress"
            : "Outcome in details";
    if (item.outcome.textContent !== status) item.outcome.textContent = status;
  }
  text(
    "execution-summary",
    count
      ? `${count} model ${count === 1 ? "request" : "requests"} · ${applicationState.activeId ? "Activity running" : applicationState.lastOutcome?.status || "Recorded activity"}`
      : "Requests and their tools appear here.",
  );
  text(
    "open-execution",
    `View execution${count ? ` · ${count} requests` : ""}`,
  );
  if (element("request-dialog").open) renderInspection(groups);
}
/** Message roles identify the speaker; actor only identifies the owning agent. */
function executionRole(entry) {
  if (entry.message?.role === "user") return "user";
  if (
    entry.message?.role === "toolResult" ||
    entry.type.startsWith("tool_execution_")
  )
    return "tool";
  if (
    entry.message?.role === "assistant" ||
    [
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "app.request_start",
      "app.request_end",
    ].includes(entry.type)
  )
    return "agent";
  return "harness";
}

function renderInspection(groups = groupTrace()) {
  const entries =
    selectedRequestFilter === "all"
      ? executionTrace()
      : (groups.get(selectedRequestFilter)?.entries ?? []);
  text(
    "request-title",
    selectedRequestFilter === "all"
      ? "Complete activity details"
      : groups.get(selectedRequestFilter)?.title || "Request details",
  );
  const existing = new Set(
    [...element("request-data").children].map((child) => child.dataset.event),
  );
  for (const entry of entries) {
    if (existing.has(entry.id)) continue;
    const details = node("details", "trace-entry");
    details.dataset.event = entry.id;
    const label = `${new Date(entry.at).toLocaleTimeString()} · ${entry.type}${entry.toolName ? ` · ${entry.toolName}` : ""}`;
    const role = executionRole(entry);
    const badge = node(
      "span",
      "trace-badge",
      {
        user: "User",
        agent: "Agent",
        tool: "Tool",
        harness: "Harness",
      }[role],
    );
    badge.dataset.role = role;
    const summary = node("summary");
    summary.append(badge);
    // Pi calls the run boundary agent_start/agent_end. Keep those raw names
    // visible while spelling out the workshop's run terminology.
    const boundary = {
      agent_start: "Run started",
      agent_end: "Run ended",
    }[entry.type];
    if (boundary)
      summary.append(
        node(
          "strong",
          "",
          `${boundary}${entry.outcome?.status ? ` · ${entry.outcome.status}` : ""}`,
        ),
        document.createTextNode(" · "),
      );
    summary.append(document.createTextNode(label));
    details.append(summary, node("pre", "", JSON.stringify(entry, null, 2)));
    if (entry.type === "app.request_start") details.open = true;
    element("request-data").append(details);
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
  const lines = content.split("\n").map((line, index) => {
    const row = node("div", "code-line");
    if (index + 1 === target.line) row.classList.add("selected");
    row.append(
      node("span", "line-number", String(index + 1)),
      node("span", "line-content", line || " "),
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
  selectedRequestFilter = "all";
  openDialog("request-dialog", element("activity-details"));
  renderInspection();
};
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
for (const kind of ["patch", "message", "message_update", "text", "trace"])
  events.addEventListener(kind, (event) => change(kind, event.data));
for (const kind of ["resync", "error"])
  events.addEventListener(kind, () => void refresh());
window.addEventListener("pagehide", () => {
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
