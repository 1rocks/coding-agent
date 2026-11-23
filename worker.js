const UPDATE_PROCESSING_TTL = 900;   // in-flight marker, 15 minutes
const UPDATE_DONE_TTL = 86400;       // completed marker, 24 hours

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/setup" && request.method === "GET") {
      if (!env.SETUP_KEY || url.searchParams.get("key") !== env.SETUP_KEY) {
        return new Response("Unauthorized", { status: 401 });
      }

      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return Response.json({ error: "Telegram configuration is incomplete." }, { status: 500 });
      }

      try {
        const { response, text } = await fetchTextWithTimeout(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: `${url.origin}/telegram`,
              secret_token: env.TELEGRAM_WEBHOOK_SECRET,
              allowed_updates: ["message", "callback_query"]
            })
          },
          TELEGRAM_TIMEOUT_MS,
          "Telegram webhook setup"
        );

        return new Response(text, {
          status: response.ok ? 200 : response.status,
          headers: { "Content-Type": "application/json" }
        });

      } catch (error) {
        console.error("Webhook setup failed:", errorMessage(error));

        return Response.json({
          error: errorMessage(error)
        }, { status: 502 });
      }
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET
      ) {
        return new Response("Unauthorized", { status: 401 });
      }

      let update;

      try {
        update = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }

      if (!env.APPROVALS) {
        return new Response("APPROVALS KV unavailable", { status: 500 });
      }

      // Deduplicate Telegram retries. The key is only marked "done" after
      // processing finishes, so a crashed update can be recovered.
      let updateKey = null;

      if (update.update_id !== undefined) {
        updateKey = `telegram:update:${update.update_id}`;

        const status = await env.APPROVALS.get(updateKey);

        // Already done, or still running in another invocation.
        if (status) return new Response("OK");

        await env.APPROVALS.put(updateKey, "processing", {
          expirationTtl: UPDATE_PROCESSING_TTL
        });
      }

      try {
        return await handleTelegramUpdate(env, update, url);

      } catch (error) {
        console.error("Telegram update failed:", errorMessage(error));

        // Returning OK stops Telegram from retrying a failing update forever.
        return new Response("OK");

      } finally {
        if (updateKey) {
          try {
            await env.APPROVALS.put(updateKey, "done", {
              expirationTtl: UPDATE_DONE_TTL
            });
          } catch (error) {
            console.error("Update completion tracking failed:", errorMessage(error));
          }
        }
      }
    }

    return new Response("LOKI Coding Agent is online.");
  }
};

// ============================================================
// TELEGRAM UPDATE ROUTER
// ============================================================

async function handleTelegramUpdate(env, update, url) {
  if (update.callback_query) {
    const acknowledged = await answerCallbackQuery(
      env,
      update.callback_query.id
    );

    try {
      await handleCallback(env, update.callback_query);

    } catch (error) {
      console.error("Callback handler failed:", errorMessage(error));

      const chatId = update.callback_query.message?.chat?.id;

      if (chatId) {
        await sendTelegram(
          env,
          chatId,
          "⚠️ Button action failed:\n" + errorMessage(error)
        );
      }
    }

    if (!acknowledged) {
      console.error("Callback acknowledgment failed.");
    }

    return new Response("OK");
  }

  const message = update.message;

  if (!message?.text || !message.from || !message.chat) {
    return new Response("OK");
  }

  if (!isAllowedUser(env, message.from.id)) {
    return new Response("OK");
  }

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (!text) return new Response("OK");

  const command = parseCommand(text);

  if (["start", "help"].includes(command.name)) {
    await sendTelegram(
      env,
      chatId,
      "🤖 LOKI Coding Agent\n\n" +
      "🧠 Primary AI: Hostless OmniRoute\n🔁 Backup: Render OmniRoute\n🔄 Last fallback: OpenRouter Free\n" +
      `🐙 GitHub: ${OWNER}/${REPO}\n📚 YouTube knowledge: Cloudflare Workers KV\n\n` +
      "MODES\n/chat - Normal conversation\n/coding - GitHub coding mode\n\n" +
      "YOUTUBE KNOWLEDGE\n/youtube <YouTube URL> - Transcript, summary, chapters and knowledge graph\n" +
      "/yt <YouTube URL> - Shortcut\n\n" +
      "OTHER\n/repo - Check GitHub access\n/help - Help\n\n" +
      "GitHub edits require your approval and create a separate branch. Main is not modified directly.\n" +
      "YouTube results are saved in Cloudflare Workers KV. Videos without accessible captions cannot be transcribed by this Cloudflare-only version."
    );

    return new Response("OK");
  }

  if (command.name === "chat") {
    await env.APPROVALS.put(`mode:${chatId}`, "chat", {
      expirationTtl: MODE_TTL
    });

    await sendTelegram(
      env,
      chatId,
      "💬 CHAT MODE ACTIVATED\nUse /coding for repository changes."
    );

    return new Response("OK");
  }

  if (command.name === "coding") {
    await env.APPROVALS.put(`mode:${chatId}`, "coding", {
      expirationTtl: MODE_TTL
    });

    if (!command.argument) {
      await sendTelegram(
        env,
        chatId,
        "💻 CODING MODE ACTIVATED\nSend a task, or use /coding Fix the bug."
      );

      return new Response("OK");
    }
  }

  if (command.name === "youtube" || command.name === "yt") {
    const videoUrl = command.argument || "";

    if (!videoUrl) {
      await sendTelegram(
        env,
        chatId,
        "Usage:\n/youtube https://www.youtube.com/watch?v=VIDEO_ID"
      );

      return new Response("OK");
    }

    await processYouTube(env, chatId, videoUrl, url.origin);

    return new Response("OK");
  }

  if (command.name === "repo") {
    await sendTelegram(env, chatId, `🐙 Checking ${OWNER}/${REPO}...`);

    try {
      const repo = await githubRequest(env, `/repos/${OWNER}/${REPO}`);

      await sendTelegram(
        env,
        chatId,
        `✅ Repository accessible\n\nRepository: ${repo.full_name}\nDefault branch: ${repo.default_branch}\nVisibility: ${repo.visibility}`
      );

    } catch (error) {
      await sendTelegram(
        env,
        chatId,
        "❌ GitHub check failed:\n" + errorMessage(error)
      );
    }

    return new Response("OK");
  }

  const storedMode = await env.APPROVALS.get(`mode:${chatId}`);
  const currentMode = storedMode || "chat";

  if (currentMode !== "coding") {
    return await handleChat(env, chatId, text);
  }

  const task = (
    command.name === "coding" ? command.argument : text
  ).trim();

  if (!task) {
    await sendTelegram(env, chatId, "Describe what you want me to code.");
    return new Response("OK");
  }

  if (task.length > 4000) {
    await sendTelegram(env, chatId, "Keep coding tasks under 4,000 characters.");
    return new Response("OK");
  }

  if (!env.GITHUB_TOKEN) {
    await sendTelegram(env, chatId, "❌ GITHUB_TOKEN is missing.");
    return new Response("OK");
  }

  if (!hasAIProvider(env)) {
    await sendTelegram(env, chatId, "❌ No AI provider is configured.");
    return new Response("OK");
  }

  // Prevent overlapping coding requests in the same chat.
  const codingLock = await acquireCodingLock(env, chatId);

  if (!codingLock) {
    await sendTelegram(
      env,
      chatId,
      "⏳ A coding request is already running in this chat.\nPlease wait for it to finish before sending another task."
    );

    return new Response("OK");
  }

  try {
    await sendTelegram(
      env,
      chatId,
      `🔍 Inspecting ${OWNER}/${REPO}...`
    );

    const repo = await githubRequest(
      env,
      `/repos/${OWNER}/${REPO}`
    );

    const branch = repo.default_branch;

    const branchInfo = await githubRequest(
      env,
      `/repos/${OWNER}/${REPO}/branches/${encodeURIComponent(branch)}`
    );

    const baseSha = branchInfo.commit.sha;

    const tree = await githubRequest(
      env,
      `/repos/${OWNER}/${REPO}/git/trees/${encodeURIComponent(baseSha)}?recursive=1`
    );

    if (tree.truncated) {
      await sendTelegram(
        env,
        chatId,
        "⚠️ GitHub returned an incomplete file listing. No proposal created."
      );

      return new Response("OK");
    }

    const candidates = tree.tree.filter(file =>
      file.type === "blob" &&
      typeof file.size === "number" &&
      file.size <= MAX_FILE_SIZE &&
      isAllowedFile(file.path)
    );

    if (!candidates.length) {
      await sendTelegram(env, chatId, "⚠️ No suitable source files found.");
      return new Response("OK");
    }

    await sendTelegram(
      env,
      chatId,
      `📂 Found ${candidates.length} suitable files. Selecting relevant source files...`
    );

    const selected = selectFiles(candidates, task).slice(0, MAX_FILES);

    let context = "";
    const originalFiles = [];

    for (const file of selected) {
      const encodedPath = file.path
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const result = await githubRequest(
        env,
        `/repos/${OWNER}/${REPO}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
      );

      if (!result.content || result.encoding !== "base64") {
        continue;
      }

      const bytes = Uint8Array.from(
        atob(result.content.replace(/\s/g, "")),
        c => c.charCodeAt(0)
      );

      const content = new TextDecoder().decode(bytes);

      const section =
        `\n--- FILE: ${file.path} ---\n${content}\n--- END FILE ---\n`;

      if (context.length + section.length > MAX_CONTEXT_SIZE) {
        continue;
      }

      context += section;

      originalFiles.push({
        path: file.path,
        content
      });
    }

    if (!originalFiles.length) {
      await sendTelegram(
        env,
        chatId,
        "⚠️ Couldn't retrieve suitable file contents."
      );

      return new Response("OK");
    }

    await sendTelegram(
      env,
      chatId,
      `📄 Retrieved ${originalFiles.length} source files:\n` +
      originalFiles.map(f => "• " + f.path).join("\n") +
      "\n\n🧠 Preparing code changes..."
    );

    const aiResult = await callAI(
      env,
      [
        {
          role: "system",
          content: buildCodingSystemPrompt()
        },
        {
          role: "user",
          content:
            `Repository: ${OWNER}/${REPO}\n` +
            `Default branch: ${branch}\n` +
            `Base commit: ${baseSha}\n\n` +
            `Coding task:\n${task}\n\n` +
            `Retrieved files:\n${context}`
        }
      ],
      chatId,
      url.origin,
      { timeoutMs: AI_LONG_TIMEOUT_MS, maxTokens: CODING_MAX_TOKENS }
    );

    if (!aiResult.answer) {
      await sendTelegram(
        env,
        chatId,
        "⚠️ All AI providers failed. No proposal created." +
        (aiResult.error ? "\n\n" + aiResult.error : "")
      );

      return new Response("OK");
    }

    await sendTelegram(
      env,
      chatId,
      `✅ AI response received from ${aiResult.provider}.\n🔍 Validating proposed changes...`
    );

    const parsed = parseCodeProposal(aiResult.answer);

    if (!parsed || !Array.isArray(parsed.files)) {
      await sendTelegram(
        env,
        chatId,
        "⚠️ AI did not return a valid structured proposal. No changes made."
      );

      return new Response("OK");
    }

    const validation = validateProposedFiles(
      parsed.files,
      originalFiles
    );

    if (!validation.ok) {
      await sendTelegram(
        env,
        chatId,
        "⚠️ Proposal rejected by validation:\n" +
        validation.reason +
        "\nNo changes made."
      );

      return new Response("OK");
    }

    if (!validation.files.length) {
      const inspected = originalFiles.map(file =>
        `• ${file.path} (${file.content.length} chars)`
      ).join("\n");

      const explanation = parsed.explanation ||
        parsed.summary ||
        "The AI returned an empty files array or unchanged file contents.";

      await sendTelegram(
        env,
        chatId,
        "ℹ️ The AI did not propose any file changes.\n\n" +
        explanation.slice(0, 1800) +
        "\n\nFILES PROVIDED TO AI\n" +
        inspected.slice(0, 1800) +
        "\n\nTry naming the exact file and the change you want."
      );

      return new Response("OK");
    }

    const proposalId = crypto.randomUUID();

    const proposal = {
      id: proposalId,
      task,
      repository: `${OWNER}/${REPO}`,
      branch,
      baseSha,
      summary: parsed.summary || "Code changes proposed.",
      explanation: parsed.explanation || "",
      files: validation.files,
      provider: aiResult.provider,
      model: aiResult.model,
      status: "pending",
      createdAt: Date.now()
    };

    await env.APPROVALS.put(
      `proposal:${chatId}:${proposalId}`,
      JSON.stringify(proposal),
      { expirationTtl: PROPOSAL_TTL }
    );

    const fileList = validation.files
      .map(file => "• " + file.path)
      .join("\n");

    await sendTelegram(
      env,
      chatId,
      `📝 CODE PROPOSAL\n\n` +
      `AI: ${aiResult.provider}\n` +
      `Model: ${aiResult.model}\n` +
      `Repository: ${OWNER}/${REPO}\n` +
      `Base branch: ${branch}\n` +
      `Files: ${validation.files.length}\n\n` +
      `SUMMARY\n${proposal.summary}\n\n` +
      `FILES\n${fileList}\n\n` +
      `EXPLANATION\n${proposal.explanation.slice(0, 1200)}\n\n` +
      "⏳ Expires in one hour. Approval creates a separate branch and commit; main is not modified.",
      {
        inline_keyboard: [[
          {
            text: "✅ Approve & Commit",
            callback_data: "approve:" + proposalId
          },
          {
            text: "❌ Reject",
            callback_data: "reject:" + proposalId
          }
        ]]
      }
    );

  } catch (error) {
    console.error("Coding task failed:", errorMessage(error));

    await sendTelegram(
      env,
      chatId,
      "⚠️ Coding task failed:\n" + errorMessage(error)
    );

  } finally {
    await releaseCodingLock(env, codingLock);
  }

  return new Response("OK");
}
