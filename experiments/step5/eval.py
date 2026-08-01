"""Rudimentary step 5 — zero-retrieval recall test.

Ask the held-out questions to BASE vs FINE-TUNED, both with empty context (no
notes injected). If the fine-tuned model answers facts the base can't, the
weight-consolidation worked.
"""
import json, pathlib, torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import PeftModel

HERE = pathlib.Path(__file__).parent
MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
torch.set_num_threads(16)

tok = AutoTokenizer.from_pretrained(MODEL)
base = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float32)
tuned = PeftModel.from_pretrained(
    AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float32),
    HERE / "adapter")

def ask(m, q):
    msgs = [{"role": "user", "content": q}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors="pt")
    with torch.no_grad():
        out = m.generate(**ids, max_new_tokens=64, do_sample=False,
                         pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()

rows = [json.loads(l) for l in open(HERE / "eval.jsonl")]
b_hits = t_hits = 0
for r in rows:
    q, key = r["q"], r["must_include"]
    ba, ta = ask(base, q), ask(tuned, q)
    bh, th = key.lower() in ba.lower(), key.lower() in ta.lower()
    b_hits += bh; t_hits += th
    print(f"\nQ: {q}\n  expect ~ '{key}'")
    print(f"  BASE  [{'HIT' if bh else 'miss'}]: {ba[:160]}")
    print(f"  TUNED [{'HIT' if th else 'miss'}]: {ta[:160]}")

n = len(rows)
print(f"\n=== zero-retrieval recall ===\n  base : {b_hits}/{n}\n  tuned: {t_hits}/{n}")
