"""Rudimentary step 5 — QLoRA-style LoRA fine-tune on CPU.

Smallest honest version: LoRA a tiny instruct model on the notes-derived Q&A so
the facts land in the weights. CPU, fp32, no bitsandbytes — reliability over
speed for a demo. Saves the adapter to ./adapter.
"""
import json, pathlib, torch
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments
from peft import LoraConfig, get_peft_model
from datasets import Dataset

HERE = pathlib.Path(__file__).parent
MODEL = "Qwen/Qwen2.5-0.5B-Instruct"
torch.set_num_threads(16)

tok = AutoTokenizer.from_pretrained(MODEL)
model = AutoModelForCausalLM.from_pretrained(MODEL, torch_dtype=torch.float32)

rows = [json.loads(l) for l in open(HERE / "train.jsonl")]

def fmt(r):
    msgs = [
        {"role": "user", "content": r["q"]},
        {"role": "assistant", "content": r["a"]},
    ]
    text = tok.apply_chat_template(msgs, tokenize=False)
    ids = tok(text, truncation=True, max_length=256, padding="max_length")
    ids["labels"] = ids["input_ids"].copy()
    return ids

ds = Dataset.from_list([fmt(r) for r in rows])

lora = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
                  task_type="CAUSAL_LM")
model = get_peft_model(model, lora)
model.print_trainable_parameters()

args = TrainingArguments(
    output_dir=str(HERE / "out"),
    per_device_train_batch_size=2,
    gradient_accumulation_steps=1,
    num_train_epochs=12,
    learning_rate=2e-4,
    logging_steps=10,
    save_strategy="no",
    report_to=[],
)
Trainer(model=model, args=args, train_dataset=ds,
        data_collator=lambda b: {k: torch.tensor([x[k] for x in b]) for k in b[0]}).train()

model.save_pretrained(HERE / "adapter")
tok.save_pretrained(HERE / "adapter")
print("SAVED_ADAPTER")
