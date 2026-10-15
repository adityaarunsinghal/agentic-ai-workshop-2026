// LEARNING: Keep each approved layout adjustment in one operation that can finish without another approval loop.
// Start: createLayoutOperations() and its forReview() function.
// Next: editorial.mjs for the review that proposes and records those choices.

import { createHash, randomUUID } from "node:crypto";

// ============================================================================
// MAIN BEHAVIOR - read this section first
// ============================================================================

export function createLayoutOperations({ store, review, cancel }) {
  let adapting = null;
  const current = () => {
    return store.snapshot().layoutOperation;
  };
  const publish = (value) => {
    return store.updateActivity({ layoutOperation: value });
  };
  const owns = (id) => {
    return current()?.id === id;
  };

  function forReview({ explicit = false, layoutOperationId } = {}) {
    const state = store.snapshot(),
      previous = state.layoutOperation;
    const basis = layoutBasis(state);
    if (layoutOperationId) {
      if (previous?.id !== layoutOperationId || previous.status !== "styling") {
        throw error("STALE_LAYOUT", "A newer edit replaced this layout operation.");
      }
      return previous;
    }
    if (!explicit && previous?.basis === basis && terminal.has(previous.status)) {
      return { ...previous, settled: true };
    }
    if (
      !explicit &&
      previous?.basis === basis &&
      ["reviewing", "offered", "failed"].includes(previous.status)
    ) {
      return previous;
    }
    adapting = null;
    const operation = {
      id: randomUUID(),
      status: "reviewing",
      basis,
      issueId: state.issue.id,
      documentVersion: state.documentVersion ?? 0,
    };
    publish(operation);
    return operation;
  }

  function reviewed(entry) {
    if (!owns(entry.receipt.layoutIntentId)) {
      return;
    }
    const state = store.snapshot(),
      previous = state.layoutOperation;
    const complete =
      entry.receipt.status === "complete" &&
      previous.approvedTemplate &&
      (previous.geometryComplete || state.settings.layoutCleanup !== "offer_tidy");
    publish({
      ...previous,
      basis: layoutBasis(state),
      status: complete
        ? "complete"
        : entry.receipt.status === "complete"
          ? "offered"
          : entry.receipt.status,
      ...(complete ? { geometryComplete: true } : {}),
      reviewRequestId: entry.receipt.requestId,
      resultRevision: entry.resultRevision,
    });
  }

  function validate(args) {
    const state = store.snapshot(),
      operation = state.layoutOperation;
    const kind =
      args.template && args.template !== state.issue.layoutTemplate
        ? "template"
        : "tidy";
    if (args.approval) {
      if (
        !operation ||
        args.approval.intentId !== operation.id ||
        operation.status !== "offered" ||
        operation.basis !== layoutBasis(state) ||
        operation.reviewRequestId !== args.approval.reviewRequestId ||
        (state.documentVersion ?? 0) !== args.approval.documentVersion ||
        state.editorial?.status !== "complete" ||
        state.editorial.resultRevision !== state.issue.revision ||
        state.editorial.requestId !== operation.reviewRequestId
      ) {
        throw error(
          "STALE_LAYOUT",
          "The newspaper changed after this layout was proposed. Prepare a new proposal.",
        );
      }
      if (
        args.approval.kind !== kind ||
        (kind === "tidy" && args.template !== undefined)
      ) {
        throw error(
          "LAYOUT_AUTHORITY",
          "A cleanup approval cannot start template adaptation.",
        );
      }
      if (
        kind === "template" &&
        (args.template !== state.settings.editorLayout || operation.approvedTemplate)
      ) {
        throw error(
          "LAYOUT_AUTHORITY",
          "Approve the current template recommendation before adapting copy.",
        );
      }
      if (kind === "tidy" && state.settings.layoutCleanup !== "offer_tidy") {
        throw error(
          "LAYOUT_AUTHORITY",
          "There is no current cleanup recommendation to approve.",
        );
      }
    } else if (operation && kind === "template") {
      throw error(
        "LAYOUT_APPROVAL_REQUIRED",
        "Template adaptation requires the current layout approval.",
      );
    }
    if (
      operation &&
      terminal.has(operation.status) &&
      operation.basis === layoutBasis(state)
    ) {
      throw error(
        "LAYOUT_COMPLETE",
        "This layout operation is complete. Edit the newspaper or choose Review issue to start another.",
      );
    }
    // Legacy direct geometry calls remain CAS-protected but cannot escalate a
    // same-template cleanup into a writer. New template calls bind the review.
    if (
      kind === "template" &&
      !args.approval &&
      (state.editorial?.status !== "complete" ||
        state.editorial.resultRevision !== state.issue.revision ||
        state.settings.editorLayout !== args.template)
    ) {
      throw error(
        "LAYOUT_APPROVAL_REQUIRED",
        "Template adaptation requires a current editorial recommendation.",
      );
    }
    return {
      id: operation?.id ?? randomUUID(),
      kind,
      issueId: state.issue.id,
      documentVersion: state.documentVersion ?? 0,
    };
  }

  function cleanup(intent) {
    adapting = null;
    cancel("The approved cleanup completed the geometry operation.");
    const state = store.snapshot();
    publish({
      ...state.layoutOperation,
      ...intent,
      status: "complete",
      geometryComplete: true,
      basis: layoutBasis(state),
      resultRevision: state.issue.revision,
    });
  }

  function beginTemplate(intent, slotIds) {
    cancel("The approved template is waiting for its copy adaptation.");
    const state = store.snapshot();
    const operation = {
      ...intent,
      status: "adapting",
      basis: layoutBasis(state),
      approvedTemplate: state.issue.layoutTemplate,
      slotIds,
    };
    adapting = {
      id: intent.id,
      baseline: state,
      slotIds: new Set(slotIds),
      renderedVersions: new Map(),
    };
    publish(operation);
    return operation.id;
  }

  async function finishTemplate(id, waitForWriters) {
    const group = adapting;
    try {
      await waitForWriters();
      if (!group || adapting !== group || !owns(id)) {
        return;
      }
      const state = store.snapshot();
      if (!unchangedOutsideWriters(group, state)) {
        invalidate(id);
        return;
      }
      const failed = state.jobs.some((job) => {
        return (
          group.slotIds.has(job.slotId) &&
          !group.baseline.jobs.some((before) => {
            return before.id === job.id;
          }) &&
          [
            "failed",
            "error",
            "incomplete",
            "cancelled",
            "superseded",
            "interrupted",
          ].includes(job.status)
        );
      });
      if (failed) {
        throw error(
          "LAYOUT_ADAPTATION_FAILED",
          "A layout writer did not complete. Its copy and error remain available; retry that story or choose Review issue.",
        );
      }
      adapting = null;
      publish({ ...current(), status: "styling", basis: layoutBasis(state) });
      await review({ reason: "approved_template_settled", layoutOperationId: id });
    } catch (failure) {
      if (owns(id)) {
        adapting = null;
        publish({ ...current(), status: "failed", reason: failure.message });
      }
      throw failure;
    }
  }

  function reviewDraft(options) {
    const state = store.snapshot(),
      operation = state.layoutOperation;
    const rendered = options.origin === "rendered_fit" && options.layoutOperationId;
    if (
      rendered &&
      (!operation ||
        operation.id !== options.layoutOperationId ||
        !operation.approvedTemplate ||
        operation.approvedTemplate !== state.issue.layoutTemplate ||
        operation.issueId !== state.issue.id ||
        operation.documentVersion !== (state.documentVersion ?? 0) ||
        ["superseded", "declined"].includes(operation.status))
    ) {
      return Promise.resolve({ state, layoutSuperseded: true });
    }
    if (
      rendered &&
      operation.status === "complete" &&
      operation.basis === layoutBasis(state)
    ) {
      return Promise.resolve({ state, layoutSettled: true });
    }
    if (adapting && owns(adapting.id) && adapting.slotIds.has(options.movedStoryId)) {
      if (
        unchangedOutsideWriters(
          adapting,
          state,
          rendered ? options.movedStoryId : undefined,
        )
      ) {
        if (rendered) {
          adapting.renderedVersions.set(
            options.movedStoryId,
            state.issue.stories.find((story) => {
              return idOf(story) === options.movedStoryId;
            }).contentVersion,
          );
        }
        return Promise.resolve({ state, deferredToLayout: adapting.id });
      }
      invalidate(adapting.id);
      if (rendered) {
        return Promise.resolve({ state: store.snapshot(), layoutSuperseded: true });
      }
    }
    if (rendered && owns(options.layoutOperationId) && !adapting) {
      // Copy fitting continues the same approved intent. Completed geometry
      // cannot become another consent loop merely because its text was fitted.
      publish({
        ...current(),
        status: "styling",
        basis: layoutBasis(store.snapshot()),
      });
      return review({ ...options, layoutOperationId: operation.id });
    }
    return review(options);
  }

  function invalidate(
    expectedId,
    reason = "The newspaper changed during layout preparation.",
  ) {
    const operation = current();
    if (!operation || (expectedId && operation.id !== expectedId)) {
      return;
    }
    adapting = null;
    publish({ ...operation, status: "superseded", reason });
    cancel(reason);
  }

  // Adapted slots may finish their writer and identified rendered corrections;
  // the rest of the newspaper is frozen.
  // Manual app actions also invalidate explicitly after their CAS mutation.
  function unchangedOutsideWriters(group, state, renderedSlotId) {
    if (
      state.issue.id !== group.baseline.issue.id ||
      state.documentVersion !== group.baseline.documentVersion ||
      state.settings.stage !== group.baseline.settings.stage
    ) {
      return false;
    }
    const comparable = structuredClone(state);
    for (const story of comparable.issue.stories) {
      if (!group.slotIds.has(idOf(story))) {
        continue;
      }
      const before = group.baseline.issue.stories.find((item) => {
        return idOf(item) === idOf(story);
      });
      const allowedVersion =
        idOf(story) === renderedSlotId
          ? story.contentVersion
          : (group.renderedVersions.get(idOf(story)) ?? before?.contentVersion + 1);
      if (
        !before ||
        story.headline !== before.headline ||
        JSON.stringify(story.sourceIds) !== JSON.stringify(before.sourceIds) ||
        story.contentVersion < before.contentVersion ||
        story.contentVersion > allowedVersion
      ) {
        return false;
      }
      story.body = before.body;
    }
    return layoutBasis(comparable) === layoutBasis(group.baseline);
  }

  return {
    forReview,
    reviewed,
    validate,
    cleanup,
    beginTemplate,
    finishTemplate,
    reviewDraft,
    invalidate,
  };
}

// ============================================================================
// SUPPORTING HELPERS - policies, validation, and bookkeeping
// ============================================================================

const hash = (value) => {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
};
const idOf = (story) => {
  return story.slotId ?? story.id;
};
const terminal = new Set(["complete", "declined"]);
const error = (code, message) => {
  return Object.assign(new Error(message), { code });
};

// Actual editorial inputs, excluding generated typography, receipt IDs, global
// revisions and progress. Those bookkeeping changes are not new user intent.
export function layoutBasis(state) {
  return hash({
    issueId: state.issue.id,
    documentVersion: state.documentVersion ?? 0,
    stage: state.settings.stage,
    model: state.settings.model,
    decisionModel: state.settings.decisionModel,
    focus: state.issue.focus,
    audience: state.issue.audience,
    editionDate: state.issue.date,
    template: state.issue.layoutTemplate,
    stories: state.issue.stories.map((story) => {
      return {
        id: idOf(story),
        headline: story.headline,
        body: story.body,
        frame: story.frame,
        section: story.section,
        hidden: story.hidden,
        locked: story.locked,
        pinned: story.pinned,
        sourceIds: story.sourceIds,
      };
    }),
    sources: state.issue.sources.map((source) => {
      return {
        id: source.id,
        title: source.title,
        url: source.url ?? source.canonicalUrl,
        text: source.text ?? source.excerpt,
        evidenceLevel: source.evidenceLevel,
        publishedAt: source.publishedAt,
      };
    }),
  });
}
