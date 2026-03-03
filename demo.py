"""
Hurricane Maria Demo — Launcher

Thin wrapper that starts the backend API server.
Run directly: python demo.py [--sample 500] [--port 8000]

For standalone backend use, run: python demo_backend.py
Frontend is served from: demo_output/index.html
"""

from demo_backend import main

if __name__ == "__main__":
    main()
