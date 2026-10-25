/**
 * Synthetic provider output, consumed by Pi AI's real OpenAI stream parser.
 * These records and answers are simulated, and never require HTTP.
 */
import { fixtureAutoResearch } from "./auto-research-fixture.mjs";
import { fixtureFactCheck } from "./fact-check-fixture.mjs";
export function simulatedSource(job) {
  return {
    id: `fixture-research-${job.id}`,
    title: "Simulated newsroom research record",
    url: "https://example.invalid/simulated-newsroom",
    text: "Simulated workshop data: a newsroom editor requests a story in a fixed slot. " +
      "Research gathers source records, preserves their identities, and supplies a cited draft. " +
      "The editor can move the slot or edit its copy while the request runs. This is a training example, not reporting.",
    evidenceLevel: "simulated",
    origin: "fixture",
    simulated: true,
  };
}

export function fixtureDecisions(payload) {
  return {
    model: payload.model,
    simulated: true,
    answers: Object.fromEntries(Object.entries(payload.questions).map(([id, question]) => {
      if (question.type === "noul") return [id, { type: "noul", noul: 0.5 }];
      const keys = Object.keys(question.criteria);
      return [id, {
        type: "choice",
        choice: keys[0],
        probabilities: Object.fromEntries(keys.map((key, index) => [key, index ? 0 : 1])),
        confidence: 1,
      }];
    })),
    usage: { input_tokens: 0, output_tokens: 0, cost: 0, simulated: true },
  };
}

export function fixtureTextCompletion(payload) {
  let input;
  const lastUser = [...payload.messages].reverse().find((message) => message.role === "user");
  try { input = JSON.parse(contentText(lastUser?.content)); } catch { /* General fixture text has no questions. */ }
  const research = fixtureAutoResearch(input);
  if (research?.__forceOutputLimit) {
    // Test seam: the audit (a run-level step) ran out of output budget. Emit a "length"
    // finish with no usable content, which the gateway maps to OUTPUT_LIMIT; the run
    // stops because the audit is not a per-claim call.
    return sseResponse({ content: "" }, "length", payload.model);
  }
  if (research) return sseResponse({ content: JSON.stringify(research) }, "stop", payload.model);
  // The fact-check turn prompts send a PROSE user message, not a JSON object, so the
  // fact-check fixture inspects the whole message list (system marker + prose user turn)
  // rather than the parsed JSON input the other fixtures use.
  const factCheck = fixtureFactCheck(payload.messages);
  if (factCheck?.__forceOutputLimit) {
    // Test seam: emit a finish_reason "length" with no usable content, exactly what the
    // model produces when it spends its whole output budget on reasoning. The gateway
    // maps this to OUTPUT_LIMIT, which the per-claim isolation path records and skips.
    return sseResponse({ content: "" }, "length", payload.model);
  }
  if (factCheck) return sseResponse({ content: JSON.stringify(factCheck) }, "stop", payload.model);
  if (input?.questions) {
    const answers = Object.fromEntries(Object.entries(input.questions).filter(
      ([, question]) => question.type === "choice",
    ).map(([id, question]) => [id, {
      type: "choice", choice: Object.keys(question.criteria)[0],
    }]));
    return sseResponse({ content: JSON.stringify({ simulated: true, answers }) }, "stop", payload.model);
  }
  const output = payload.response_format ?
    JSON.stringify({ simulated: true, text: "Simulated workshop text response." }) :
    "Simulated workshop text response; no live model was called.";
  return sseResponse({ content: output }, "stop", payload.model);
}

function contentText(content) {
  return typeof content === "string" ? content :
    (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function requestContext(payload) {
  for (const message of payload.messages) {
    const text = contentText(message.content);
    for (const prefix of ["Story request:\n", "Briefing request:\n", "Resize request:\n"])
      if (text.startsWith(prefix)) return JSON.parse(text.slice(prefix.length));
  }
  return {};
}

function toolArguments(tool, values) {
  const schema = tool.function.parameters;
  const args = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (key in values) args[key] = values[key];
    else if ("const" in property) args[key] = property.const;
    else if ("default" in property) args[key] = property.default;
    else if (schema.required?.includes(key) && property.enum?.length) args[key] = property.enum[0];
  }
  return schema.required?.some((key) => !(key in args)) ? null : args;
}

export function fixtureCompletion(payload, { step = 0, endlessTools = false, failFinal = false } = {}) {
  const context = requestContext(payload);
  if (context.task === "resize") {
    const copy = context.copy;
    const words = [copy.body, ...(context.evidence ?? []).map((source) => source.text)]
      .join(" ").trim().split(/\s+/u);
    return sseResponse({ content: JSON.stringify({
      headline: copy.headline,
      body: words.slice(0, context.target.maximumWords).join(" "),
      sourceIds: copy.sourceIds,
    }) }, "stop", payload.model);
  }
  if (context.task === "briefing")
    return fixtureBriefingCompletion(payload, { step, endlessTools, failFinal });
  const observed = [];
  for (const message of payload.messages.filter((message) => message.role === "tool")) {
    try {
      const value = JSON.parse(contentText(message.content));
      if (Array.isArray(value.records)) observed.push(...value.records);
    } catch { /* Skill and permission results need not be JSON source batches. */ }
  }
  const read = [...observed].reverse().find((source) => source.text &&
    !["metadata", "feed-summary", "search-snippet"].includes(source.evidenceLevel));
  const sourceId = read?.id ?? context.sources?.find((source) => source.simulated)?.id;
  const readable = observed.find((source) => source.url || source.canonicalUrl);
  const draft = {
    headline: "Simulated newsroom report",
    body: "Simulated data: an editor requests a cited story. Research preserves the source " +
      "identity and the movable slot. This workshop example is not real reporting.",
    sourceIds: sourceId ? [sourceId] : [],
  };
  if ((context.budget?.maxWords ?? 100) < 30)
    draft.body = "Simulated data: a newsroom researches a cited draft. This is a workshop example.";
  const tools = payload.tools ?? [];
  let selected;
  const values = {
    issueId: context.issueId,
    slotId: context.slotId,
    requestId: context.requestId,
    baseContentVersion: context.baseContentVersion,
    prompt: context.prompt,
    query: context.prompt,
    count: 3,
    limit: 3,
    sourceId: step === 1 && readable ? readable.id : sourceId,
    url: step === 1 && readable ? readable.url ?? readable.canonicalUrl : undefined,
    id: sourceId,
    ...draft,
  };
  if (payload.tool_choice !== "none") {
    if (endlessTools) selected = tools.find((tool) => tool.function.name !== "write_story");
    else if (step === 0)
      selected = tools.find((tool) => /^(search_hn|search_google_news|search_news)$/u.test(tool.function.name));
    else if (step === 1 && sourceId)
      selected = tools.find((tool) => tool.function.name === "read_source") ??
        (readable ? tools.find((tool) => tool.function.name === "fetch_read") : undefined) ??
        tools.find((tool) => tool.function.name === "write_story");
    else if (step <= 2 && sourceId)
      selected = tools.find((tool) => tool.function.name === "write_story");
  }
  const args = selected ? toolArguments(selected, values) : null;
  if (selected && args) {
    return sseResponse({
      tool_calls: [{
        index: 0,
        id: `fixture-call-${step + 1}`,
        type: "function",
        function: { name: selected.function.name, arguments: JSON.stringify(args) },
      }],
    }, "tool_calls", payload.model);
  }
  if (failFinal) return new Response(JSON.stringify({ error: { message: "Simulated final inference failure." } }), {
    status: 503, headers: { "content-type": "application/json" },
  });
  return sseResponse({ content: JSON.stringify(draft) }, "stop", payload.model);
}

/** Exercise the advertised MCP declarations, like Session 1's small HN recipe. */
export function fixtureBriefingCompletion(payload, { step = 0, endlessTools = false, failFinal = false } = {}) {
  const records = new Map();
  for (const message of payload.messages.filter((message) => message.role === "tool")) {
    try {
      const observation = JSON.parse(contentText(message.content));
      for (const record of observation.records ?? []) records.set(record.id, record);
    } catch { /* Skill text and preferences are also genuine tool observations. */ }
  }
  const selected = [...records.values()].slice(0, 3);
  const recipe = [
    ["read_skill", { name: "hn-briefing" }],
    ["inspect_user_preferences", {}],
    ["list_stories", { category: "top", count: 3 }],
    ["propose_briefing", { recommendations: selected.map((record) => ({
      sourceId: record.id, note: "A scripted recommendation from the returned HN metadata.",
    })) }],
  ];
  const [name, values] = endlessTools ? recipe[2] : recipe[step] ?? [];
  const tool = payload.tool_choice !== "none" &&
    (payload.tools ?? []).find((item) => item.function.name === name);
  const args = tool && toolArguments(tool, values);
  if (tool && args && (name !== "propose_briefing" || selected.length))
    return sseResponse({ tool_calls: [{
      index: 0, id: `fixture-briefing-${step + 1}`, type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }] }, "tool_calls", payload.model);
  if (failFinal)
    return new Response(JSON.stringify({ error: { message: "Simulated final inference failure." } }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  const answer = "Scripted preview: these HN recommendations use synthetic metadata. Linked articles have not been read.\n\n" +
    (selected.length ? selected.map((record) =>
      `- [${record.title}](${record.canonicalUrl ?? record.url})`,
    ).join("\n") : "No HN records were observed in this request.");
  return sseResponse({ content: answer }, "stop", payload.model);
}

export function sseResponse(delta, finishReason, model) {
  const chunk = {
    id: "fixture-completion",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "x-fixture-simulated": "true" },
  });
}
