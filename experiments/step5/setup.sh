set -e
cd /home/jt/Desktop/cascade/experiments/step5
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python \
  torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv/bin/python \
  "transformers>=4.44" peft datasets accelerate
echo "SETUP_DONE"
