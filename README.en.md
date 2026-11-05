# Personal OpenBot Group

[简体中文](README.md) | **English**

Work alongside Bots that remember context and get things done, on your own computer.

Personal OpenBot Group is a desktop app for working with AI Bots. Give them different roles, chat with them individually, or bring them into a group. Discuss an idea, put it into action, and review the result—all through conversation.

## Work that carries forward

Each Bot maintains its own memory and tasks. It carries context between private and group chats, retaining preferences, decisions, and lessons from past work. In a group, it considers the topic and other members’ messages before joining in. You can also @mention a Bot to ask it to take something on.

A conversation model interprets requests, plans work, and reviews results. Codex or Claude Code on your computer handles files, commands, and web access. Bots can delegate, deliver, and review tasks with one another. You can follow progress, refine a request, or stop execution; follow-up work stays in the original session.

Closing the window keeps the app running in the menu bar or system tray until you explicitly quit.

## Get started

Download an installer from [GitHub Releases](https://github.com/bug-origin/Personal-OpenBot-Group/releases). The currently available and verified build is for **macOS Apple Silicon**.

You will need an API key for a conversation model, plus **Codex CLI or Claude Code** installed and signed in. The installer includes the app’s runtime.

1. Open **Settings**, choose a model provider, enter your API key, and select the primary conversation model.
2. Create a Bot, give it a name and role, and choose Codex or Claude Code as its execution tool.
3. Start a private chat, or create a group and invite your Bots.

Supported providers include DeepSeek, OpenAI, Anthropic, Gemini, Qwen, Moonshot, Zhipu AI, and other OpenAI-compatible services. Attention decisions use the primary conversation model by default; you can configure a separate model.

## Running locally

Chats, memories, and tasks are stored on your computer. Conversation content is sent to the model service you configure. Local execution uses your existing Codex or Claude Code settings and sign-in, with file and command operations governed by that tool’s permissions.

The app currently supports one person on one computer. See [Troubleshooting and data recovery](docs/troubleshooting.md) for storage, backups, and connection issues, and [Security](SECURITY.md) for security boundaries.

## Development

Running from source requires **Node.js 22.18+** and npm. The desktop window also requires Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run desktop
```

For browser development, use `npm run dev`. Configure models in the app’s settings; environment variables are documented in [.env.example](.env.example).

The interface uses React and Tauri, the local service uses Fastify and SQLite, and the Bridge connects local execution tools. See [Architecture](docs/architecture.md), [Contributing](CONTRIBUTING.md), or [Building and releasing](docs/releasing.md). The [documentation index](docs/README.md) covers the rest. These detailed guides are currently in Chinese.

Licensed under the [MIT License](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party code and dependencies.
