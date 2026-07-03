# Copilot Review Instructions

- This repo requires Python >= 3.14 (see `requires-python` in `pyproject.toml` and PEP 723 script headers). Before flagging Python code as a syntax error or as invalid, check whether it is valid under the newest accepted PEPs for that version (e.g. PEP 758 unparenthesized `except A, B:`). Formatting style is owned by ruff format at that target version — do not flag constructs it produces.
