"""Rudimentary step 5 — consolidation -> training dataset.

Turns facts distilled from @claude's _agent/memory notes into instruction/answer
pairs. This is the one genuinely new piece: the notes become the fine-tune set.
Held-out eval questions ask for facts that live ONLY in the notes, so a base
model has no way to know them — the test is whether fine-tuning put them in the
weights (zero retrieval, empty context).
"""
import json, pathlib

OUT = pathlib.Path(__file__).parent

# (question, answer) facts drawn from the actual memory notes. Multiple
# paraphrases per fact — tiny models need repetition to memorize.
TRAIN = [
    ("Which commit introduced the two-layer scratchpad memory system in Cascade?",
     "Commit 9ec7e48a (2026-07-23) introduced the two-layer scratchpad memory system."),
    ("What commit added the agent scratchpad journal?",
     "It was commit 9ec7e48a, landed 2026-07-23."),
    ("What are the five journal entry kinds in cascade-scratchpad?",
     "The five kinds are: observation, outcome, dead-end, decision, and todo."),
    ("List the cascade-scratchpad jot kinds.",
     "observation, outcome, dead-end, decision, todo."),
    ("What is the default value of SCRATCHPAD_DUE_ENTRIES?",
     "The default value of SCRATCHPAD_DUE_ENTRIES is 10."),
    ("After how many unconsolidated entries is consolidation flagged as due?",
     "After 10 entries — SCRATCHPAD_DUE_ENTRIES defaults to 10."),
    ("What is the default of SCRATCHPAD_DUE_AGE_HOURS?",
     "SCRATCHPAD_DUE_AGE_HOURS defaults to 24 hours."),
    ("Which two older memory systems did the scratchpad replace?",
     "It replaced exocortex (BM25 recall) and the per-run auto-capture system."),
    ("What did the scratchpad system remove in favor of itself?",
     "It removed two systems: exocortex, which did BM25 recall, and per-run auto-capture."),
    ("What backend is agent 5.5 wired to in Cascade?",
     "Agent 5.5 is wired to the Codex CLI backend."),
    ("How did agent 5.5 fail?",
     "It crashed on invoke with 'Codex exited with code 1' while reading from stdin."),
    ("What is the e2e test script for the scratchpad?",
     "The e2e test is scripts/test-scratchpad-e2e.mjs."),
    ("In the CLS framing, what does the journal correspond to?",
     "The journal corresponds to the hippocampus — fast, episodic, high learning rate."),
    ("In the CLS framing, what do the model weights correspond to?",
     "The weights correspond to the neocortex — slow, generalizing; left frozen in the current system."),
    ("Why does the server never spawn consolidation runs itself?",
     "Because server-spawned runs would ride the desktop's Claude subscription login, but the Agent SDK terms require API-key auth."),
    ("What is step 5 of the augmentation ladder?",
     "Step 5 is a periodic batch fine-tune of the note corpus — the actual neocortical consolidation step."),
]

# Held out — answers appear ONLY in the notes; base model cannot know them.
EVAL = [
    ("Which commit introduced the two-layer scratchpad memory system in Cascade?", "9ec7e48a"),
    ("What are the five journal entry kinds in cascade-scratchpad?", "dead-end"),
    ("What is the default value of SCRATCHPAD_DUE_ENTRIES?", "10"),
    ("What backend is agent 5.5 wired to, and what error did it fail with?", "Codex exited with code 1"),
    ("Which two older memory systems did the scratchpad replace?", "exocortex"),
]

with open(OUT / "train.jsonl", "w") as f:
    for q, a in TRAIN:
        f.write(json.dumps({"q": q, "a": a}) + "\n")
with open(OUT / "eval.jsonl", "w") as f:
    for q, a in EVAL:
        f.write(json.dumps({"q": q, "must_include": a}) + "\n")
print(f"wrote {len(TRAIN)} train, {len(EVAL)} eval pairs")
