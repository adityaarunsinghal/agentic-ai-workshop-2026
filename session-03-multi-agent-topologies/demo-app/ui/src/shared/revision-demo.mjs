import { structuredResult, toolError } from "./state.mjs";

export const REVISION_DEMO_LABEL = "Revise copy to become defensible";
export const REVISION_DEMO_MESSAGE = "Auto-revisions would have started";

export async function requestRevisionDemo(callTool) {
  const result = await callTool("revise_copy_demo", {});
  if (!result) throw new Error("The demonstration did not return a confirmation.");
  const failure = toolError(result);
  if (failure) throw failure;
  const data = structuredResult(result);
  const message = data?.message ?? result.content?.find((block) => block.type === "text" && block.text === REVISION_DEMO_MESSAGE)?.text;
  if (message !== REVISION_DEMO_MESSAGE) throw new Error("The demonstration returned an unexpected confirmation. Inspect Execution for its response.");
  return { message, requestId: data?.requestId ?? data?.traceId ?? null };
}
