import { query } from '@anthropic-ai/claude-agent-sdk';
import { getNote, rescanVault } from './vault.js';
/**
 * Runs a full agent session using the Claude Agent SDK to locate and evaluate
 * all inline and block AI directives in the note, editing the markdown file
 * directly on disk and rescanning to update the database cache.
 */
export async function runDirectivesInNote(db, noteId) {
    const note = getNote(db, noteId);
    if (!note)
        throw new Error('Note not found');
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(note.vault_id);
    if (!vault)
        throw new Error('Vault not found');
    const RUNNER_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
    const RUNNER_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 15);
    const agentPrompt = `
You are a notes assistant. In the note titled "${note.title}.md", there are AI directives that need to be evaluated and updated.
Please find the directives in "${note.title}.md", execute their requests, and rewrite the file content to replace each directive with the response as follows:

1. For inline directives matching \`{{ai: prompt}}\`, replace the directive with:
\`{{ai_done: prompt}}\\n\\n> ✨ **AI:** [model response]\`

2. For block directives matching:
\\\`\\\`\\\`llm
prompt
\\\`\\\`\\\`
replace the directive block with:
\\\`\\\`\\\`llm_done
prompt
\\\`\\\`\\\`

### Output
[model response]

Please read the note content first, evaluate the prompts, execute any tool actions if the prompts ask to find other notes, search, summarize, etc., and then use the file editing tools to update "${note.title}.md" on disk. Do not edit other files unless explicitly instructed by a prompt.
`;
    const stream = query({
        prompt: agentPrompt,
        options: {
            cwd: vault.root_path,
            model: RUNNER_MODEL,
            maxTurns: RUNNER_MAX_TURNS,
            permissionMode: 'acceptEdits',
            systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: `You are an assistant for the Cascade Notes application. Cwd is the vault root. Use standard tools to read and write files to process the user's note-taking requests.`,
            },
        },
    });
    // Wait for the agent session to complete
    for await (const _message of stream) {
        // Consume stream
    }
    // Rescan vault to sync all changes to the database cache
    rescanVault(db, vault.id, vault.created_by);
    const updatedNote = getNote(db, noteId);
    return updatedNote ? updatedNote.content : '';
}
