/** Command dispatcher for cascade-chat. Each command owns only its API workflow. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { USAGE, parseArgs, fail, errorMessage, readHelperConfig, configString, optionString, baseUrl, getToken, api, readStdin, optionInt, normalizeInlineMessage, markChatSendUsed, mediaSummary, writeAttachment, fetchLimit, selectWindow, decorateMessages, formatHuman } from './cascade-chat-common.mjs';

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args._[0];
  if (!raw || args.help) {
    process.stdout.write(USAGE + '\n');
    process.exit(raw ? 0 : 1);
  }
  const cmd = raw === 'attachments' ? 'attachment' : raw;
  if (!['history', 'send', 'members', 'mission', 'avatar', 'distill', 'search', 'attachment'].includes(cmd)) {
    fail(`unknown command "${raw}". Run with --help.`);
  }

  const config = readHelperConfig();
  const vaultId = optionString(args, 'vault', 'CASCADE_NOTE_VAULT', config, 'vaultId');
  const channelId = optionString(args, 'channel', 'CASCADE_CHAT_CHANNEL', config, 'chatChannelId');
  if (!vaultId) fail('missing vault. Pass --vault or set CASCADE_NOTE_VAULT.');
  if (cmd !== 'search' && !channelId) fail('missing channel. Pass --channel or set CASCADE_CHAT_CHANNEL.');

  const url = baseUrl(args, config, { ignoreArgsUrl: cmd === 'avatar' });
  const token = await getToken(url, args, config);
  if (cmd === 'members') {
    const { agents = [] } = await api(
      url,
      token,
      'GET',
      `/api/vaults/${vaultId}/channels/${channelId}/agents`,
    );
    const members = agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      mention: agent.mention,
      agentId: agent.agentId,
      model: agent.model || '',
      orchestrator: agent.orchestrator === true,
      taggableByAgents: agent.taggableByAgents === true,
    }));
    if (args.json) process.stdout.write(JSON.stringify(members) + '\n');
    else process.stdout.write((members.map((agent) => (
      `@${agent.mention}  ${agent.displayName}  ${agent.agentId}${agent.model ? ` · ${agent.model}` : ''}${agent.orchestrator ? ' · coordinator' : ''}`
    )).join('\n') || '(no agents)') + '\n');
    return;
  }

  if (cmd === 'mission') {
    const sub = String(args._[1] || 'status').toLowerCase();
    const registrationId = configString(config, 'registrationId');
    const missionRef = String(args.mission || args._[2] || 'current').trim() || 'current';
    if (sub === 'start') {
      if (!registrationId) fail('mission start can only be used from a registered coordinator run.');
      const title = String(args.title || '').trim();
      if (!title) fail('mission start needs --title <text>.');
      const triggerMessageId = String(
        args.root
        || configString(config, 'chatTriggeringMessageId')
        || process.env.CASCADE_CHAT_TRIGGERING_MESSAGE
        || '',
      ).trim();
      // Mission cards project onto root_message_id. Always attach under a
      // coordinator shell (Supagrok header), not the human triggering message.
      const syntheticId = `sys-mission-root-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const synthetic = await api(
        url,
        token,
        'POST',
        `/api/vaults/${vaultId}/channels/${channelId}/messages`,
        {
          id: syntheticId,
          channelId,
          author: configString(config, 'displayName') || configString(config, 'mention') || 'Coordinator',
          registrationId,
          body: String(args.objective || '').trim() || title,
          createdAt: new Date().toISOString(),
          ...(triggerMessageId
            ? { replyTo: { messageId: triggerMessageId, author: '', preview: title } }
            : {}),
        },
      );
      const rootMessageId = String(synthetic.message?.id || syntheticId).trim();
      if (!rootMessageId) fail('mission start could not create a coordinator root message.');
      const result = await api(
        url,
        token,
        'POST',
        `/api/vaults/${vaultId}/channels/${channelId}/missions`,
        {
          rootMessageId,
          coordinatorRegistrationId: registrationId,
          title,
          objective: String(args.objective || '').trim(),
        },
      );
      if (args.json) process.stdout.write(JSON.stringify(result.mission) + '\n');
      else process.stdout.write(`mission ${result.mission.id} started: ${result.mission.title}\n`);
      return;
    }
    if (sub === 'status' || sub === 'show') {
      const coordinator = registrationId ? `?coordinator=${encodeURIComponent(registrationId)}` : '';
      const result = await api(
        url,
        token,
        'GET',
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${encodeURIComponent(missionRef)}${coordinator}`,
      );
      if (args.json) process.stdout.write(JSON.stringify(result.mission) + '\n');
      else {
        const mission = result.mission;
        const tasks = (mission.tasks || []).map((task) => (
          `  ${task.status === 'completed' ? '✓' : task.status === 'failed' || task.status === 'blocked' ? '!' : '·'} ${task.id}  ${task.title} — @${task.assigneeMention || task.assignee} (${task.status})${task.summary ? `\n      ${task.summary}` : ''}`
        )).join('\n');
        process.stdout.write(`${mission.status}  ${mission.id}  ${mission.title}\n${tasks || '  (no tasks)'}\n`);
      }
      return;
    }
    if (sub === 'list') {
      const coordinator = registrationId ? `?coordinator=${encodeURIComponent(registrationId)}` : '';
      const result = await api(
        url,
        token,
        'GET',
        `/api/vaults/${vaultId}/channels/${channelId}/missions${coordinator}`,
      );
      if (args.json) process.stdout.write(JSON.stringify(result.missions || []) + '\n');
      else {
        const lines = (result.missions || []).map((mission) => (
          `${mission.status.padEnd(10)}  ${mission.id}  ${mission.title}  · ${(mission.tasks || []).length} tasks`
        ));
        process.stdout.write((lines.join('\n') || '(no missions)') + '\n');
      }
      return;
    }
    if (sub === 'history') {
      if (!missionRef || missionRef === 'current') {
        fail('mission history needs --mission <id>.');
      }
      const result = await api(
        url,
        token,
        'GET',
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${encodeURIComponent(missionRef)}/history`,
      );
      if (args.json) process.stdout.write(JSON.stringify(result.events || []) + '\n');
      else {
        const lines = (result.events || []).map((event) => {
          const transition = event.fromStatus && event.toStatus
            ? `${event.fromStatus} → ${event.toStatus}`
            : event.toStatus || event.kind.replaceAll('_', ' ');
          const attempt = event.attempt > 0 ? ` · attempt ${event.attempt + 1}` : '';
          return `${event.createdAt}  ${transition}${attempt}  ${event.title || event.kind}${event.summary ? `\n    ${event.summary}` : ''}`;
        });
        process.stdout.write((lines.join('\n') || '(no mission events)') + '\n');
      }
      return;
    }
    if (sub === 'delegate') {
      if (!registrationId) fail('mission delegate can only be used from a registered coordinator run.');
      const assignee = String(args.to || '').trim();
      const title = String(args.task || args.title || '').trim();
      if (!assignee) fail('mission delegate needs --to <@agent>.');
      if (!title) fail('mission delegate needs --task <title>.');
      const fromStdin = args.message === true || args.message === undefined;
      const rawPrompt = fromStdin ? await readStdin() : args.message;
      const prompt = (fromStdin
        ? String(rawPrompt)
        : normalizeInlineMessage(rawPrompt, args['raw-message'] === true)).trim() || title;
      const result = await api(
        url,
        token,
        'POST',
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${encodeURIComponent(missionRef)}/tasks`,
        {
          coordinatorRegistrationId: registrationId,
          title,
          assignee,
          prompt,
          dependsOn: String(args.after || '').split(',').map((item) => item.trim()).filter(Boolean),
          priority: Number(args.priority) || 0,
          reasoningEffort: String(args.effort || '').trim().toLowerCase(),
          anonymous: args.anonymous === true,
        },
      );
      if (args.json) process.stdout.write(JSON.stringify({ mission: result.mission, task: result.task }) + '\n');
      else {
        const mention = result.task.assigneeMention || result.task.assignee;
        process.stdout.write(`${result.scheduled ? 'dispatched' : 'scheduled'} ${result.task.id} to @${mention}: ${result.task.title}\n`);
      }
      return;
    }
    if (sub === 'update' || sub === 'retry') {
      const taskId = String(args.task || args._[2] || '').trim();
      const status = sub === 'retry' ? 'pending' : String(args.status || '').trim().toLowerCase();
      if (!taskId) fail(`mission ${sub} needs --task <id>.`);
      if (!['pending', 'running', 'completed', 'failed', 'blocked', 'canceled'].includes(status)) {
        fail('mission update needs --status pending|running|completed|failed|blocked|canceled.');
      }
      const result = await api(
        url,
        token,
        'PATCH',
        `/api/vaults/${vaultId}/channels/${channelId}/missions/tasks/${encodeURIComponent(taskId)}`,
        { status, summary: String(args.summary || '').trim() },
      );
      if (args.json) process.stdout.write(JSON.stringify(result.mission) + '\n');
      else process.stdout.write(sub === 'retry' ? `task ${taskId} queued for retry\n` : `task ${taskId} → ${status}\n`);
      return;
    }
    if (sub === 'finish' || sub === 'cancel') {
      if (!registrationId) fail(`mission ${sub} can only be used from a registered coordinator run.`);
      const result = await api(
        url,
        token,
        'POST',
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${encodeURIComponent(missionRef)}/finish`,
        {
          coordinatorRegistrationId: registrationId,
          status: sub === 'cancel' ? 'canceled' : 'completed',
          summary: String(args.summary || '').trim(),
        },
      );
      if (args.json) process.stdout.write(JSON.stringify(result.mission) + '\n');
      else process.stdout.write(`mission ${result.mission.id} → ${result.mission.status}\n`);
      return;
    }
    fail(`unknown mission command "${sub}". Use start|list|status|history|delegate|update|retry|finish|cancel.`);
  }

  if (cmd === 'avatar') {
    const registrationId = configString(config, 'registrationId');
    if (!registrationId) fail('avatar can only be used from a registered agent chat run.');
    const avatarUrl = args.clear === true
      ? ''
      : String(args['avatar-url'] || args.url || '').trim();
    if (!args.clear && !avatarUrl) fail('missing --url <https-url>, or use --clear.');
    if (!args.clear && !/^https?:\/\//i.test(avatarUrl)) fail('profile picture must be an http(s) URL');
    const result = await api(
      url, token, 'PUT',
      `/api/vaults/${vaultId}/channels/${channelId}/agents/${encodeURIComponent(registrationId)}/avatar`,
      { avatarUrl },
    );
    process.stdout.write(result.registration?.avatarUrl ? 'profile picture updated\n' : 'profile picture cleared\n');
    return;
  }

  if (cmd === 'search') {
    const q = args._.slice(1).join(' ').trim();
    if (!q) fail('search needs a query.');
    const scope = String(args.scope || 'chat').trim() || 'chat';
    const limit = optionInt(args, 'limit', 30);
    const channelQ = channelId ? `&channel=${encodeURIComponent(channelId)}` : '';
    const { results = [] } = await api(
      url,
      token,
      'GET',
      `/api/vaults/${vaultId}/search?q=${encodeURIComponent(q)}&scope=${encodeURIComponent(scope)}&limit=${limit}${channelQ}`,
    );
    if (args.json) process.stdout.write(JSON.stringify(results) + '\n');
    else {
      process.stdout.write(
        (results.map((r) => `[${r.type || '?'}] ${r.id}  ${r.title || ''}\n  ${r.snippet || ''}`).join('\n\n')
          || '(no matches)') + '\n',
      );
    }
    return;
  }

  if (cmd === 'distill') {
    const mode = String(args.mode || 'create').trim() || 'create';
    const payload = {
      mode,
      fromMessageId: String(args.from || '').trim() || undefined,
      toMessageId: String(args.to || '').trim() || undefined,
      lastN: args.last !== undefined ? optionInt(args, 'last', 30) : undefined,
      note: String(args.note || '').trim() || undefined,
      title: String(args.title || '').trim() || undefined,
      confirm: args.confirm === true,
    };
    const result = await api(
      url,
      token,
      'POST',
      `/api/vaults/${vaultId}/channels/${channelId}/distill`,
      payload,
    );
    if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
    else if (result.status === 'needs_confirm') {
      process.stdout.write(
        `merge draft ready for note ${result.priorNoteId || ''}. Re-run with --confirm to write.\n`,
      );
      if (result.draft) process.stdout.write(result.draft.slice(0, 2000) + (result.draft.length > 2000 ? '\n…\n' : '\n'));
    } else if (result.status === 'exists') {
      process.stdout.write(
        `already distilled → ${result.note?.id || result.priorNoteId}  ${result.note?.title || ''}\nUse --mode append to add more.\n`,
      );
    } else {
      process.stdout.write(
        `distilled (${result.mode}) → ${result.note?.id || ''}  ${result.note?.title || ''}\n`,
      );
    }
    return;
  }

  if (cmd === 'attachment') {
    // The transcript an agent sees is text; this is how it opens the picture.
    // The list payload strips heavy data URLs, so the file always comes from the
    // detail endpoint. With an explicit id that is the *only* call needed —
    // listing the channel first just to confirm the id exists is wasted bytes.
    const base = `/api/vaults/${vaultId}/channels/${channelId}/messages`;
    const wanted = optionString(args, 'message-id');
    let messageId = wanted;
    if (!messageId) {
      const { messages = [] } = await api(url, token, 'GET', `${base}?limit=120`);
      const found = [...messages].reverse().find((message) => mediaSummary(message));
      if (!found) fail('no message with an attachment found.');
      messageId = found.id;
    }

    // Own the 404 here: api() would surface it as a raw HTTP status.
    const res = await fetch(`${url}${base}/${encodeURIComponent(messageId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) fail(`message ${messageId} not found in this channel.`);
    const target = (await res.json()).message;
    if (!target) fail(`message ${messageId} not found in this channel.`);
    const full = target;

    const outDir = optionString(args, 'out')
      || fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-attachment-'));
    fs.mkdirSync(outDir, { recursive: true });
    const sources = [
      ...(full.images || []).map((src, index) => ({ url: src, name: '', index })),
      ...(full.attachments || []).map((item, index) => ({ ...item, index: (full.images || []).length + index })),
    ];
    const written = [];
    for (const source of sources) {
      const saved = await writeAttachment(source, outDir, `${target.id}-${source.index}`, token);
      if (saved) written.push(saved);
    }
    if (!written.length) fail(`message ${target.id} has no readable attachment.`);
    if (args.json) process.stdout.write(JSON.stringify({ messageId: target.id, files: written }) + '\n');
    else {
      process.stdout.write(`${target.id} (${target.author}): ${written.length} file(s)\n`);
      for (const file of written) process.stdout.write(`  ${file.path}  ${file.media_type}\n`);
    }
    return;
  }

  if (cmd === 'send') {
    const fromStdin = args.message === true || args.message === undefined;
    const rawBody = fromStdin ? await readStdin() : args.message;
    const body = (fromStdin
      ? String(rawBody)
      : normalizeInlineMessage(rawBody, args['raw-message'] === true)).trim();
    if (!body) fail('missing message. Pass --message <text> or pipe text on stdin.');
    const registrationId = configString(config, 'registrationId');
    const agentId = configString(config, 'agentId');
    const collaborationTarget = optionString(args, 'to');
    const collaborationSource = optionString(args, 'reply-to');
    const collaborationRelation = optionString(args, 'relation');
    const collaborationRequested = Boolean(collaborationTarget || collaborationSource || collaborationRelation);
    if (collaborationRequested) {
      if (!collaborationTarget || !collaborationSource || !collaborationRelation) {
        fail('typed handoff requires --to, --reply-to, and --relation.');
      }
      const allowed = new Set(['builds_on', 'review_request', 'question', 'contradiction', 'decision']);
      if (!allowed.has(collaborationRelation)) fail(`invalid --relation: ${collaborationRelation}`);
      if (!registrationId) fail('typed handoff requires an active registered-agent context.');
      if (typeof args['changes-file'] === 'string') fail('--changes-file cannot be combined with a typed handoff.');
      const requestId = `collab-${agentId || 'agent'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await api(
        url,
        token,
        'POST',
        `/api/vaults/${vaultId}/channels/${channelId}/messages/${encodeURIComponent(collaborationSource)}/collaborate`,
        {
          target: collaborationTarget,
          relationship: collaborationRelation,
          instruction: body,
          requestId,
          registrationId,
        },
      );
      const sent = result.message || { id: requestId };
      process.stdout.write(`asked ${collaborationTarget} via ${collaborationRelation} (${sent.id})\n`);
      return;
    }
    const inferredAuthor = inferAuthor(args, config);
    const author = optionString(args, 'author', 'CASCADE_CHAT_AUTHOR', config, 'chatAuthor')
      || inferredAuthor
      || (registrationId ? '' : 'Agent');
    const idPrefix = agentId || (author && author !== 'Agent' ? author.toLowerCase().replace(/\s+/g, '-') : 'msg');
    let changeRequest;
    if (typeof args['changes-file'] === 'string') {
      const parsed = JSON.parse(fs.readFileSync(path.resolve(args['changes-file']), 'utf8'));
      if (!parsed || !Array.isArray(parsed.files)) fail('--changes-file must contain a JSON object with a files array.');
      changeRequest = {
        files: parsed.files.map((file) => ({
          path: String(file.path || ''),
          additions: Math.max(0, Number(file.additions) || 0),
          deletions: Math.max(0, Number(file.deletions) || 0),
        })).filter((file) => file.path),
        ...(parsed.commit ? { commit: String(parsed.commit) } : {}),
        ...(parsed.ref ? { ref: String(parsed.ref) } : {}),
        approvals: [],
      };
    }
    const message = {
      id: `agent-${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      author,
      body,
      createdAt: new Date().toISOString(),
      ...(agentId ? { agentId } : {}),
      ...(registrationId ? { registrationId } : {}),
      ...(changeRequest ? { changeRequest } : {}),
    };
    const result = await api(url, token, 'POST', `/api/vaults/${vaultId}/channels/${channelId}/messages`, message);
    const sent = result.message || message;
    // Mark this run so the desktop runner suppresses the stream-body bubble
    // (avoids double-posting the same reply via stdout + cascade-chat send).
    markChatSendUsed(config);
    process.stdout.write(`sent ${sent.id || message.id}\n`);
    return;
  }
  const listPath = `/api/vaults/${vaultId}/channels/${channelId}/messages`;
  const requested = fetchLimit(args);
  let { messages = [] } = await api(url, token, 'GET', `${listPath}?limit=${requested}`);
  // Only pay for the full channel when the anchor really wasn't in the page.
  const anchor = optionString(args, 'before-message-id') || optionString(args, 'around-message-id');
  if (anchor && requested < 500 && !messages.some((message) => message.id === anchor)) {
    ({ messages = [] } = await api(url, token, 'GET', `${listPath}?limit=500`));
  }
  const selected = selectWindow(messages, args);
  const output = decorateMessages(messages, selected, args);

  if (args.json) process.stdout.write(JSON.stringify(output) + '\n');
  else process.stdout.write(formatHuman(output) + '\n');
}


