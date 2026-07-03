# Copilot Review Instructions

- This repo requires Python >= 3.14 (see `requires-python` in `pyproject.toml` and PEP 723 script headers). Before flagging Python code as a syntax error or as invalid, check whether it is valid under the newest accepted PEPs for that version (e.g. PEP 758 unparenthesized `except A, B:`). Formatting style is owned by ruff format at that target version — do not flag constructs it produces.
- Type annotations target that same Python version: typeshed generics may have PEP 696 default type parameters (e.g. `AsyncGenerator[None]` is a valid full specialization — the send type defaults to `None`). Do not flag partially-parameterized generics as invalid without checking the current typeshed defaults; the CI gate runs pyrefly strict, which is the authority.
