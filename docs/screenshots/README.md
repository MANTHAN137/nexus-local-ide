# Screenshot gallery

Screenshots of Nexus 0.4.1, including a desktop capture supplied by the project owner and five captures of the React renderer in its browser design preview.

## Desktop workbench

Captured on 8 October 2026. The desktop app shows the Demo project, registered local models, runtime logs and M5 resource readings. The orange character is a desktop overlay, not part of Nexus.

![Desktop workbench with the Demo project, local models and logs](desktop-workbench.png)

## Browser preview captures

Captured on 7 October 2026 using only the included example workspace and an empty model registry. Native filesystem access, model inference, RAM readings and MCP execution require the desktop app and are not simulated in these preview captures.

## Editor workbench

Explorer, Monaco editor, agent/chat/edit modes and the chat input with MCP OFF.

![Editor workbench](workbench.jpg)

## Local model library

Import an existing GGUF or connect a model directory. No weights are bundled in this repository.

![Model library](model-library.jpg)

## Resource settings

Memory policy, processing mode, manual unloading and resource labels. Readings are unavailable in the browser preview.

![Resource settings](resource-settings.jpg)

## Agent assignments

Enable roles and choose their models. Roles execute sequentially.

![Agent assignments](agent-assignments.jpg)

## MCP server setup

Configure installed local stdio servers with a name, executable and JSON arguments.

![MCP settings](mcp-settings.jpg)
