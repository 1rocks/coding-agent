/**
 * telegram-coding-agent: conservative repaired baseline
 *
 * IMPORTANT:
 * - This is a separate replacement artifact. It does not deploy itself or modify GitHub.
 * - GitHub repository writes are deliberately disabled in this version.
 * - Enable writes only after Durable Object deployment, migrations, and integration tests
 *   have been verified. The approval record and callback validation below are not a
 *   substitute for a tested, idempotent GitHub execution state machine.
 */

const MODEL = "openrouter/free";
const GITHUB_OWNER = "1rocks";
const GITHUB_REPO = "coding-agent";
const GITHUB_API = "https://api.github.com";
const TELEGRAM_API = "https://api.telegram.org";
const MAX_PROPOSAL_FILES = 20;
const MAX_FILE_BYTES = 100_000;
const WRITE_PATH_READY = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/setup" && request.method === "GET") {
      return handleSetup(request, env);
    }

    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (
      !env.TELEGRAM_WEBHOOK_SECRET ||
      !constantTimeEqual(suppliedSecret || "", env.TELEGRAM_WEBHOOK_SECRET)
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    try {
      if (update.callback_query) {
        await answerCallback(env, update.callback_query.id);
        await handleCallback(env, update.callback_query);
      } else if (update.message) {
        await handleMessage(env, update.message);
      }
    } catch (error) {
      console.error("Update handler failed:", safeError(error));
    }

    return Response.json({ ok: true });
  },
};

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

function safeError(error) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : String(error).slice(0, 500);
}

async function handleSetup(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (
    !env.SETUP_KEY ||
    !key ||
    !constantTimeEqual(key, env.SETUP_KEY)
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Missing Telegram configuration", { status: 500 });
  }

  const response = await telegramRequest(env, "setWebhook", {
    url: `${url.origin}/webhook`,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });

  return Response.json(response);
}

function isAllowedUser(env, userId) {
  return Boolean(env.ALLOWED_TELEGRAM_USER_ID) &&
    String(userId) === String(env.ALLOWED_TELEGRAM_USER_ID);
}

async function handleMessage(env, message) {
  if (
    !message?.from ||
    !message?.chat ||
    !isAllowedUser(env, message.from.id)
  ) {
    return;
  }

  const text = String(message.text || "").trim();

  if (text === "/start" || text === "/help") {
    await sendTelegram(
      env,
      message.chat.id,
      "🤖 Coding Agent\n\n" +
      "/repo <task>  Create a review proposal for the connected repository.\n" +
      "/help  Show this help.\n\n" +
      "This version can draft proposals and record approval decisions. " +
      "GitHub writes are disabled until the write workflow is fully tested."
    );
    return;
  }

  if (text === "/repo") {
    await sendTelegram(
      env,
      message.chat.id,
      "Usage: /repo <describe the change you want>"
    );
    return;
  }

  if (text.startsWith("/repo ")) {
    if (!env.OPENROUTER_API_KEY || !env.GITHUB_TOKEN) {
      await sendTelegram(
        env,
        message.chat.id,
        "Configuration is incomplete. Check the Worker secrets."
      );
      return;
    }

    const task = text.slice(6).trim();

    if (!task) {
      await sendTelegram(
        env,
        message.chat.id,
        "Please describe the change after /repo."
      );
      return;
    }

    await createProposal(env, message, task);
    return;
  }

  await sendTelegram(
    env,
    message.chat.id,
    "Use /help to see available commands."
  );
}

async function createProposal(env, message, task) {
  await sendTelegram(
    env,
    message.chat.id,
    "🔎 Reviewing the repository and drafting a proposal…"
  );

  const [branch, files] = await Promise.all([
    githubRequest(
      env,
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/ref/heads/main`
    ),
    githubRequest(
      env,
      `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/main?recursive=1`
    ),
  ]);

  if (!branch?.object?.sha || !Array.isArray(files?.tree)) {
    throw new Error(
      "Could not verify the repository's main branch and file tree."
    );
  }

  const candidates = files.tree
    .filter(
      item => item.type === "blob" && isSafeRelativePath(item.path)
    )
    .slice(0, 60);

  const snippets = [];

  for (const item of candidates.slice(0, 15)) {
    if (item.size > 30_000) continue;

    try {
      const result = await githubRequest(
        env,
        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodePath(item.path)}?ref=${branch.object.sha}`
      );

      if (
        result?.encoding === "base64" &&
        typeof result.content === "string"
      ) {
        const content = decodeBase64Utf8(result.content);

        snippets.push({
          path: item.path,
          sha: result.sha,
          content: content.slice(0, 5000),
        });
      }
    } catch (error) {
      if (!String(error.message).includes("GitHub HTTP 404")) {
        throw error;
      }
    }
  }

  const prompt = [
    "You are a cautious coding assistant. Return ONLY valid JSON with this schema:",
    '{"summary":"string","changes":[{"path":"relative/path","action":"create|modify|delete","baseSha":"sha or null","content":"full new file content or null","reason":"string"}],"tests":["string"]}',
    "Rules:",
    "- Do not claim you made changes. You are proposing changes only.",
    "- Only propose paths present in the supplied repository tree, except a new path for action=create.",
    "- For modify/delete, baseSha must exactly match the supplied file SHA.",
    "- For create, baseSha must be null and the path must not already exist.",
    "- Never modify secrets, workflow permissions, deployment config, or authentication/security code.",
    "- Limit to 5 files. Each content value must be complete, not a diff.",
    "- Do not include markdown fences.",
    "",
    `User task: ${task}`,
    "",
    `Verified base commit: ${branch.object.sha}`,
    "Repository files:",
    JSON.stringify(snippets),
  ].join("\n");

  const completion = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/1rocks/coding-agent",
        "X-Title": "Telegram Coding Agent",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: "Generate cautious repository change proposals. Output valid JSON only.",
          },
          { role: "user", content: prompt },
        ],
      }),
    }
  );

  const completionBody = await readJsonResponse(completion, "OpenRouter");
  const raw = completionBody?.choices?.[0]?.message?.content;

  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("The model returned no proposal.");
  }

  const parsed = parseJsonObject(raw);
  const proposal = validateProposal(
    parsed,
    snippets,
    candidates,
    branch.object.sha
  );

  proposal.id = crypto.randomUUID();
  proposal.chatId = String(message.chat.id);
  proposal.userId = String(message.from.id);
  proposal.originMessageId = null;
  proposal.status = "pending";
  proposal.createdAt = Date.now();
  proposal.integrityHash = await computeProposalIntegrity(proposal);

  await saveProposal(env, proposal);

  const buttons = {
    inline_keyboard: [[
      {
        text: "✅ Approve (record only)",
        callback_data: `ap:${proposal.id}`,
      },
      {
        text: "❌ Reject",
        callback_data: `rj:${proposal.id}`,
      },
    ]],
  };

  const sent = await sendTelegram(
    env,
    message.chat.id,
    formatProposal(proposal) +
      "\n\n⚠️ Approval records a decision only. No repository changes will be applied.",
    buttons
  );

  if (sent?.result?.message_id) {
    proposal.originMessageId = String(sent.result.message_id);
    proposal.integrityHash = await computeProposalIntegrity(proposal);
    await saveProposal(env, proposal);
  }
}

function validateProposal(parsed, snippets, treeItems, baseCommitSha) {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Model output is not a JSON object.");
  }

  if (typeof parsed.summary !== "string" || !parsed.summary.trim()) {
    throw new Error("Proposal has no summary.");
  }

  if (!Array.isArray(parsed.changes) || parsed.changes.length > 5) {
    throw new Error("Proposal must contain at most five changes.");
  }

  const existing = new Map(
    snippets.map(file => [file.path, file.sha])
  );

  const treePaths = new Set(treeItems.map(item => item.path));
  const seen = new Set();
  const changes = [];

  for (const change of parsed.changes) {
    if (!change || typeof change !== "object") {
      throw new Error("Invalid change entry.");
    }

    const path = String(change.path || "");
    const action = change.action;

    if (!isSafeRelativePath(path)) {
      throw new Error(`Unsafe path: ${path}`);
    }

    if (seen.has(path)) {
      throw new Error(`Duplicate path: ${path}`);
    }

    seen.add(path);

    if (!["create", "modify", "delete"].includes(action)) {
      throw new Error(`Invalid action for ${path}.`);
    }

    if (action === "create") {
      if (treePaths.has(path) || change.baseSha !== null) {
        throw new Error(
          `Create must target a new path with baseSha null: ${path}`
        );
      }

      if (typeof change.content !== "string") {
        throw new Error(`Create requires content: ${path}`);
      }
    } else {
      const actualSha = existing.get(path);

      if (!actualSha || change.baseSha !== actualSha) {
        throw new Error(
          `Modify/delete must target a supplied file with its exact SHA: ${path}`
        );
      }

      if (
        action === "modify" &&
        typeof change.content !== "string"
      ) {
        throw new Error(`Modify requires full file content: ${path}`);
      }

      if (action === "delete" && change.content !== null) {
        throw new Error(`Delete content must be null: ${path}`);
      }
    }

    if (typeof change.reason !== "string") {
      throw new Error(`Missing reason: ${path}`);
    }

    if (
      typeof change.content === "string" &&
      new TextEncoder().encode(change.content).length > MAX_FILE_BYTES
    ) {
      throw new Error(`File is too large: ${path}`);
    }

    changes.push({
      path,
      action,
      baseSha: change.baseSha,
      content: change.content,
      reason: change.reason.slice(0, 500),
    });
  }

  if (changes.length === 0) {
    throw new Error("Proposal contains no changes.");
  }

  return {
    summary: parsed.summary.slice(0, 1500),
    changes,
    tests: Array.isArray(parsed.tests)
      ? parsed.tests
          .filter(test => typeof test === "string")
          .slice(0, 10)
      : [],
    baseCommitSha,
  };
}

function isSafeRelativePath(path) {
  if (typeof path !== "string" || !path || path.length > 240) {
    return false;
  }

  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    return false;
  }

  const segments = path.split("/");

  if (
    segments.some(
      segment =>
        !segment ||
        segment === "." ||
        segment === ".."
    )
  ) {
    return false;
  }

  if (/^(?:\.git|\.github\/workflows)(?:\/|$)/i.test(path)) {
    return false;
  }

  return true;
}

function encodePath(path) {
  return path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function parseJsonObject(raw) {
  let text = raw.trim();

  if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error("Model output did not contain a JSON object.");
  }

  return JSON.parse(text.slice(start, end + 1));
}

async function computeProposalIntegrity(proposal) {
  const canonical = {
    id: proposal.id,
    chatId: proposal.chatId,
    userId: proposal.userId,
    originMessageId: proposal.originMessageId,
    summary: proposal.summary,
    changes: proposal.changes,
    tests: proposal.tests,
    baseCommitSha: proposal.baseCommitSha,
    createdAt: proposal.createdAt,
  };

  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function saveProposal(env, proposal) {
  if (env.PROPOSAL_DO) {
    const id = env.PROPOSAL_DO.idFromName(proposal.id);
    const stub = env.PROPOSAL_DO.get(id);

    const response = await stub.fetch(
      "https://proposal.internal/store",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proposal }),
      }
    );

    if (!response.ok) {
      throw new Error(`Proposal storage failed (${response.status}).`);
    }

    return;
  }

  if (!env.APPROVALS) {
    throw new Error("No proposal storage binding configured.");
  }

  await env.APPROVALS.put(
    `proposal:${proposal.id}`,
    JSON.stringify(proposal),
    { expirationTtl: 60 * 60 * 24 * 7 }
  );
}

async function loadProposal(env, id) {
  if (env.PROPOSAL_DO) {
    const stub = env.PROPOSAL_DO.get(
      env.PROPOSAL_DO.idFromName(id)
    );

    const response = await stub.fetch(
      "https://proposal.internal/load",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }
    );

    if (response.status === 404) return null;

    if (!response.ok) {
      throw new Error(`Proposal lookup failed (${response.status}).`);
    }

    return (await response.json()).proposal || null;
  }

  if (!env.APPROVALS) {
    throw new Error("No proposal storage binding configured.");
  }

  const raw = await env.APPROVALS.get(`proposal:${id}`);

  return raw ? JSON.parse(raw) : null;
}

async function handleCallback(env, callback) {
  if (
    !callback?.from ||
    !callback?.message ||
    !isAllowedUser(env, callback.from.id)
  ) {
    return;
  }

  const data = String(callback.data || "");
  const match = /^(ap|rj):([0-9a-f-]{36})$/.exec(data);

  if (!match) return;

  const [, action, id] = match;
  const proposal = await loadProposal(env, id);

  if (!proposal) {
    await sendTelegram(
      env,
      callback.message.chat.id,
      "This proposal has expired or cannot be found."
    );
    return;
  }

  const actualChatId = String(callback.message.chat.id);
  const actualMessageId = String(callback.message.message_id);

  if (
    String(proposal.userId) !== String(callback.from.id) ||
    String(proposal.chatId) !== actualChatId ||
    !proposal.originMessageId ||
    String(proposal.originMessageId) !== actualMessageId
  ) {
    await sendTelegram(
      env,
      callback.message.chat.id,
      "This button does not match the original proposal message."
    );
    return;
  }

  if (!/^[0-9a-f]{64}$/.test(proposal.integrityHash || "")) {
    await sendTelegram(
      env,
      callback.message.chat.id,
      "Proposal integrity data is missing. This proposal is blocked."
    );
    return;
  }

  const expectedHash = await computeProposalIntegrity(proposal);

  if (!constantTimeEqual(expectedHash, proposal.integrityHash)) {
    await sendTelegram(
      env,
      callback.message.chat.id,
      "Proposal integrity check failed. This proposal is blocked."
    );
    return;
  }

  if (proposal.status !== "pending") {
    await sendTelegram(
      env,
      callback.message.chat.id,
      `This proposal has already been handled (${proposal.status}).`
    );
    return;
  }

  // KV is not atomic. This implementation is intentionally record-only.
  // Do not use it to authorize GitHub writes.
  const decision = action === "ap"
    ? "approved_recorded_only"
    : "rejected";

  proposal.status = decision;
  proposal.decidedAt = Date.now();
  proposal.decidedBy = String(callback.from.id);

  await saveProposal(env, proposal);

  const responseMessage = action === "ap"
    ? "✅ Approval recorded. GitHub writes are disabled, so no files or branches were changed."
    : "❌ Proposal rejected. No repository changes were made.";

  await sendTelegram(
    env,
    callback.message.chat.id,
    responseMessage
  );
}

async function answerCallback(env, callbackId) {
  if (!callbackId || !env.TELEGRAM_BOT_TOKEN) return;

  try {
    await telegramRequest(
      env,
      "answerCallbackQuery",
      { callback_query_id: callbackId }
    );
  } catch (error) {
    console.error(
      "Could not acknowledge callback:",
      safeError(error)
    );
  }
}

function formatProposal(proposal) {
  const lines = [
    "🧾 PROPOSAL READY",
    "",
    proposal.summary,
    "",
    `Base commit: ${proposal.baseCommitSha}`,
    `Files: ${proposal.changes.length}`,
  ];

  for (const change of proposal.changes) {
    lines.push(
      "",
      `• ${change.action.toUpperCase()}: ${change.path}`,
      `  ${change.reason}`
    );
  }

  if (proposal.tests.length) {
    lines.push(
      "",
      "Suggested tests:",
      ...proposal.tests.map(test => `• ${test}`)
    );
  }

  return lines.join("\n").slice(0, 3800);
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(
    binary,
    char => char.charCodeAt(0)
  );

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readJsonResponse(response, service) {
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `${service} returned invalid JSON (HTTP ${response.status}).`
    );
  }

  if (!response.ok) {
    const detail =
      body?.error?.message ||
      body?.message ||
      response.statusText;

    throw new Error(
      `${service} HTTP ${response.status}: ${String(detail).slice(0, 300)}`
    );
  }

  return body;
}

async function githubRequest(env, path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  return readJsonResponse(response, "GitHub");
}

async function telegramRequest(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  }

  const response = await fetch(
    `${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  return readJsonResponse(response, "Telegram");
}

async function sendTelegram(env, chatId, text, replyMarkup) {
  const payload = {
    chat_id: chatId,
    text,
  };

  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }

  return telegramRequest(env, "sendMessage", payload);
}

/**
 * Durable Object storage helper only.
 *
 * It does NOT implement atomic approval decisions or GitHub execution.
 * Do not treat this class as write authorization.
 */
export class ProposalExecutor {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/store") {
      let body;

      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      if (!body?.proposal?.id || !body.proposal.integrityHash) {
        return new Response("Invalid proposal", { status: 400 });
      }

      await this.state.storage.put(
        `proposal:${body.proposal.id}`,
        body.proposal
      );

      return Response.json({ ok: true });
    }

    if (url.pathname === "/load") {
      let body;

      try {
        body = await request.json();
      } catch {
        return new Response("Bad JSON", { status: 400 });
      }

      const id = String(body?.id || "");

      if (!/^[0-9a-f-]{36}$/.test(id)) {
        return new Response("Invalid proposal ID", { status: 400 });
      }

      const proposal = await this.state.storage.get(`proposal:${id}`);

      return proposal
        ? Response.json({ proposal })
        : new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  }
}
