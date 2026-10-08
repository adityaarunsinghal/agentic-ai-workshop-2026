const form = document.querySelector("form");
const input = document.querySelector("textarea");
const send = document.querySelector("button");
const chat = document.querySelector("#chat");
const status = document.querySelector("#status");
let loading = false, submitting = false, rendered = "";

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch("/state", {cache: "no-store"});
    if (!response.ok) throw Error("Return to the portal.");
    const state = await response.json();
    const next = JSON.stringify(state.chat);
    if (next !== rendered) {
      rendered = next;
      chat.replaceChildren(...state.chat.map(([role, text]) => {
        const article = document.createElement("article");
        const label = document.createElement("strong");
        article.className = role;
        label.textContent = role.toUpperCase();
        article.append(label, document.createTextNode(text));
        return article;
      }));
      chat.scrollTop = chat.scrollHeight;
    }
    const wasDisabled = input.disabled;
    send.disabled = input.disabled = state.busy || submitting;
    if (wasDisabled && !input.disabled) input.focus();
    status.textContent = state.error || (state.busy ? "Thinking…" : "Chat lasts for this visit.");
  } catch (error) {
    status.textContent = error.message;
    send.disabled = true;
  } finally {
    loading = false;
  }
}

form.onsubmit = async (event) => {
  event.preventDefault();
  if (send.disabled || !input.value.trim()) return;
  submitting = send.disabled = input.disabled = true;
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({text: input.value}),
    });
    if (!response.ok) throw Error((await response.json()).error);
    input.value = "";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submitting = false;
    await refresh();
    if (!input.disabled) input.focus();
  }
};
input.onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
};
void refresh();
setInterval(refresh, 500);
