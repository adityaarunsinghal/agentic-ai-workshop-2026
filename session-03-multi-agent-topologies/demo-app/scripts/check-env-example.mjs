// Generated from the shared environment-example policy. Source SHA256: c9b63c394d0a2207f105100ad56f77f7c2b93cb1b32d824d4ca07a7670ce7d14
const settingSuffix = /_(?:FILE|PATH|DIR|DIRECTORY|URL|URI|ENDPOINT|HOST|PORT|TIMEOUT(?:_MS|_SECONDS)?|TTL(?:_MS|_SECONDS)?|LENGTH|SIZE|LIMIT|COUNT|ENABLED|REQUIRED)$/;
const credentialWords = /(?:^|_)(?:TOKEN|SECRETS?|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|AUTHORIZATION|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY)(?:_|$)/;
function credentialName(name, query = false) {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  if (settingSuffix.test(normalized)) return false;
  return credentialWords.test(normalized) || query && /^(?:KEY|AUTH|SIG|SIGNATURE|JWT)$/.test(normalized) || query && /(?:^|_)SIGNATURE$/.test(normalized);
}
function placeholder(value) {
  return value === "" || /^(?:example(?:[-_]value)?|change[-_]?me|replace[-_]me|your[-_][a-z0-9_-]+|<[^<>\r\n]+>|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/i.test(value);
}
function urlCredentials(value) {
  const text = value.replace(/\\\//g, "/");
  if (/\/\/[^/?#\s"'`\\,]*@/.test(text)) return true;
  for (const match of text.matchAll(/\/\/[^\s"'`\\,]+/g)) {
    const url = match[0], hash = url.indexOf("#"), question = url.indexOf("?");
    const parts = [];
    if (question !== -1 && (hash === -1 || question < hash)) {
      parts.push(url.slice(question + 1, hash === -1 ? void 0 : hash));
    }
    if (hash !== -1) {
      const fragment = url.slice(hash + 1);
      parts.push(fragment.slice(fragment.indexOf("?") + 1));
    }
    for (const part of parts) for (const [name, entry] of new URLSearchParams(part)) {
      if (credentialName(name, true) && !placeholder(entry)) return true;
      if (/\/\/[^/?#\s"'`\\,]*@/.test(entry)) return true;
    }
  }
  return false;
}
function inspectEnvExample(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1, source = lines[index].trim();
    if (!source || source.startsWith("#")) continue;
    const assignment = /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(source);
    const name = assignment?.[1];
    const location = { line, ...name && name.length <= 128 ? { variable: name } : {} };
    if (!assignment || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) {
      return { reason: "ENV_EXAMPLE_SYNTAX", ...location };
    }
    let value = assignment[2];
    const quote = value[0];
    if (quote === "'" || quote === '"' || quote === "`") {
      const parts = [];
      let segment = value.slice(1), closed = false;
      for (; ; ) {
        let end = 0;
        for (; end < segment.length; end++) {
          if (segment[end] === "\\") {
            end++;
            continue;
          }
          if (segment[end] === quote) {
            closed = true;
            break;
          }
        }
        if (closed) {
          const trailing = segment.slice(end + 1).trim();
          if (trailing && !trailing.startsWith("#")) return { reason: "ENV_EXAMPLE_SYNTAX", ...location };
          parts.push(segment.slice(0, end));
          break;
        }
        parts.push(segment);
        if (++index >= lines.length) return { reason: "ENV_EXAMPLE_SYNTAX", ...location };
        segment = lines[index];
      }
      value = parts.join("\n").replace(/\\(['"`\\])/g, (match, escaped) => escaped === quote || escaped === "\\" ? escaped : match);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = value.split("#", 1)[0].trim();
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
      return { reason: "ENV_EXAMPLE_SYNTAX", ...location };
    }
    if (credentialName(assignment[1]) && !placeholder(value)) {
      return { reason: "ENV_EXAMPLE_SECRET", kind: "credential_field", ...location };
    }
    if (urlCredentials(value)) return { reason: "ENV_EXAMPLE_SECRET", kind: "url_credentials", ...location };
  }
  return void 0;
}
function envExampleMessage(issue) {
  const location = `.env.example${issue.line ? ` on line ${issue.line}` : ""}${issue.variable ? ` (${issue.variable})` : ""}`;
  if (issue.reason === "ENV_EXAMPLE_SYNTAX") {
    return `Invalid dotenv syntax in ${location}. Use NAME=value with matching quotes and optional comments.`;
  }
  if (issue.kind === "url_credentials") {
    return `A URL in ${location} contains credentials. Remove URL userinfo and leave credential query values empty or use obvious placeholders.`;
  }
  if (issue.kind === "credential_field") {
    return `A credential field in ${location} must be empty or an obvious placeholder. Keep personal credentials in your local .env, outside the ZIP.`;
  }
  return `Credential material in ${location} must be removed or replaced with obvious placeholders. Keep personal credentials in your local .env, outside the ZIP.`;
}
export {
  envExampleMessage,
  inspectEnvExample
};

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const files = JSON.parse(input);
    if (!Array.isArray(files)) throw new Error();
    for (const file of files) {
      if (typeof file.path !== "string" || typeof file.text !== "string") throw new Error();
      const issue = inspectEnvExample(file.text);
      if (issue) {
        process.stdout.write(JSON.stringify({ error: envExampleMessage(issue), path: file.path, ...issue }));
        process.exitCode = 1;
        break;
      }
    }
  } catch {
    process.stdout.write(JSON.stringify({ error: "The example configuration could not be checked." }));
    process.exitCode = 1;
  }
}
