import type Database from 'better-sqlite3';
import { getNote, listNotes, searchNotes } from './vault.js';

type Db = Database.Database;

/**
 * Interface to call the LLM.
 * Calls the Anthropic Claude Messages API using the native Node fetch API if ANTHROPIC_API_KEY is present.
 * Falls back to a mock response otherwise to ensure the app is testable.
 */
export async function callLLM(prompt: string, context: string = ''): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return `[Mock AI Response: Set ANTHROPIC_API_KEY in your .env file to enable live LLM generations]\n\nBased on your prompt "${prompt}", here is what I would do: I would analyze your vault notes and write a response here.`;
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 2048,
        system: `You are an intelligent Obsidian-style notes assistant. Keep your response concise. ${context}`,
        messages: [
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({})) as any;
      throw new Error(errData.error?.message || `HTTP error ${response.status}`);
    }

    const data = await response.json() as any;
    return data.content?.[0]?.text || '';
  } catch (err) {
    console.error('Error calling Anthropic API:', err);
    return `Error calling LLM: ${err instanceof Error ? err.message : String(err)}`;
  }
}
