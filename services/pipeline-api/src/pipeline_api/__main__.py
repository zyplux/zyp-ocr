from __future__ import annotations

import argparse
import os

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(prog="pipeline-api")
    parser.add_argument("--mock", action="store_true", help="run with the canned mock OCR path")
    parser.add_argument("--host", default=os.environ.get("PIPELINE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIPELINE_PORT", "8000")))
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()

    factory = "pipeline_api.mock:create_app" if args.mock else "pipeline_api.app:create_app"
    uvicorn.run(factory, factory=True, host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()
