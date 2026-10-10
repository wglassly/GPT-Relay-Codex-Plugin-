# GPT Relay Codex Plugin

[中文说明](./README.zh-Hant.md) | [English details](./README.en.md)

## Experimental standalone CLI (this fork)

This fork adds a text-only CLI that connects to a dedicated local Chrome instance through Playwright/CDP. It reuses the upstream relay's submission, polling, session storage, and Markdown extraction, without requiring the desktop app's `browser-client` runtime.

Requires Node.js 22+ and Google Chrome:

```bash
npm ci
npm run relay -- login
# Sign in manually in the dedicated Chrome window and leave it open.
npm run relay -- ask "Reply with exactly RELAY_OK"
```

See [CLI usage and limitations](./plugins/gpt-relay/docs/cli.md). The remaining sections describe the original desktop plugin.

GPT Relay is a Codex plugin that relays prompts from Codex to ChatGPT through your existing Chrome session, then returns the completed ChatGPT response, generated images, Deep Research reports, and conversation links back to Codex.

It is designed for users who want Codex to ask ChatGPT with visible ChatGPT Intelligence options such as GPT 5.5 Pro Extended, GPT 5.4 Thinking Light, Deep Research, web search, image generation, and file uploads.

> This is an independent community plugin by Prompt Case. It is not an official OpenAI or ChatGPT product.

## Demo

### Codex Install Screen

![GPT Relay install screen](./media/plugin-install-screen.png)

### Codex and ChatGPT Side-by-Side

The demo below shows Codex calling GPT Relay while Chrome opens ChatGPT, switches the requested visible model/mode/effort, sends the prompt, and returns the result.

![GPT Relay demo](./media/gpt-relay-demo.gif)

## Install

### Option A: Install From The Codex UI

In Codex, open **Plugins** → **Manage** → **Create** → **Add marketplace**, then fill in:

| Field | Value |
| --- | --- |
| Source | `Toolsai/GPT-Relay-Codex-Plugin-` |
| Git ref | `main` |
| Sparse paths | Leave blank for the normal install. Optionally use `.agents/plugins` and `plugins/gpt-relay` if your Codex build asks for sparse checkout paths. |

After adding the marketplace, install **GPT Relay**, then start a new Codex thread.

### Option B: Add The Marketplace From The CLI

Run this command in your Codex environment:

```bash
codex plugin marketplace add Toolsai/GPT-Relay-Codex-Plugin-
```

Then install **GPT Relay** from the Codex Plugins UI and start a new Codex thread.

## Chrome Setup

GPT Relay controls ChatGPT through your existing Chrome session, so you need the official Codex Chrome extension installed and enabled.

### Install The Codex Chrome Extension

Install the official Codex extension from the Chrome Web Store:

[Codex on Chrome Web Store](https://chromewebstore.google.com/detail/codex/hehggadaopoacecdllhhajmbjkdcmajg)

![Codex Chrome extension on Chrome Web Store](./media/chrome-web-store-codex-extension.png)

### Enable File Uploads

If you want GPT Relay to upload local files or images to ChatGPT, enable file URL access for the Codex Chrome extension:

1. Open Chrome **Manage Extensions**.
2. Open **Details** for the Codex extension.
3. Turn on **Allow access to file URLs**.

![Allow access to file URLs for Codex Chrome extension](./media/chrome-extension-file-urls.png)

## Requirements

- Codex with plugin support.
- Official Codex Chrome extension installed and enabled.
- A logged-in ChatGPT session in Chrome.
- **Allow access to file URLs** enabled if you want GPT Relay to upload local attachments.
- Your ChatGPT account must have access to the model or mode you request. For example, Pro mode requires a ChatGPT Pro account.

## Marketplace Package

This repository is structured as a Codex plugin marketplace source. Codex needs:

- `.agents/plugins/marketplace.json` at the repository root.
- `plugins/gpt-relay/.codex-plugin/plugin.json`.
- The plugin source folder at `plugins/gpt-relay`.
- A valid Git ref, normally `main`.

The Codex **Add marketplace** dialog adds this repository as a custom marketplace source. It is different from publishing to an official built-in OpenAI marketplace.

## What It Can Do

- Keep your current ChatGPT Intelligence selection when you do not request a model change.
- Switch visible ChatGPT Intelligence options when requested, such as `5.5 Pro Extended` or `5.4 Thinking Light`.
- Refuse clearly when the requested option is not visible in your account, instead of silently falling back to another model.
- Send prompts and supported file attachments to ChatGPT.
- Return ChatGPT replies as normal Markdown, preserving headings, lists, tables, links, and code blocks where possible.
- Return generated images as local image artifacts.
- Export completed Deep Research reports to Markdown artifacts.
- Keep session metadata so you can continue or poll long-running ChatGPT tasks.

## Example Prompts

```text
Use GPT 5.5 Pro Extended to analyze this question: ...
```

```text
Run Deep Research on this topic: ...
```

```text
Switch to GPT 5.4 Thinking Light and analyze this image.
```

## Update

To update the marketplace source later:

```bash
codex plugin marketplace upgrade gpt-relay
```

Update or reinstall **GPT Relay** from the Codex Plugins UI, then start a new Codex thread.

## Notes

- GPT Relay operates through the visible ChatGPT web UI. If ChatGPT changes its UI, selectors may need updates.
- The plugin reports the visible model/mode/effort selected in ChatGPT. It does not claim hidden backend state.
- It will stop on login prompts, CAPTCHA, permission dialogs, or unavailable account features.
