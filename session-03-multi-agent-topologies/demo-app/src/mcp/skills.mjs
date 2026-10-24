import { readFile } from "node:fs/promises";

export async function readSkill(name) {
  const file = name === "story-research" ? "research-briefing.md" : "hn-briefing.md";
  return readFile(new URL(`../../skills/${file}`, import.meta.url), "utf8");
}
