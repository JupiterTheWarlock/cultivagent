#!/usr/bin/env node

const agent = process.argv[2];
const root = (process.argv[3] ?? process.cwd()).replaceAll("\\", "/");

const events = {
  codex: [
    ["SessionStart", true],
    ["UserPromptSubmit", false],
    ["PreToolUse", true],
    ["PermissionRequest", true],
    ["PostToolUse", true],
    ["SubagentStart", true],
    ["SubagentStop", true],
    ["PreCompact", true],
    ["PostCompact", true],
    ["Stop", false],
  ],
  claude: [
    ["SessionStart", true],
    ["Setup", true],
    ["InstructionsLoaded", true],
    ["UserPromptSubmit", false],
    ["UserPromptExpansion", true],
    ["MessageDisplay", false],
    ["PreToolUse", true],
    ["PermissionRequest", true],
    ["PostToolUse", true],
    ["PostToolUseFailure", true],
    ["PostToolBatch", false],
    ["PermissionDenied", true],
    ["Notification", true],
    ["SubagentStart", true],
    ["SubagentStop", true],
    ["TaskCreated", false],
    ["TaskCompleted", false],
    ["Stop", false],
    ["StopFailure", true],
    ["TeammateIdle", false],
    ["ConfigChange", true],
    ["CwdChanged", false],
    ["FileChanged", true],
    ["WorktreeCreate", false],
    ["WorktreeRemove", false],
    ["PreCompact", true],
    ["PostCompact", true],
    ["SessionEnd", true],
    ["Elicitation", true],
    ["ElicitationResult", true],
  ],
};

if (!events[agent]) {
  console.error("usage: node scripts/generate-hook-config.mjs codex|claude [cultivagent-root]");
  process.exit(2);
}

const script = `${root}/scripts/${agent === "codex" ? "codex" : "claude"}-hook.mjs`;
const hooks = {};
for (const [name, matcher] of events[agent]) {
  const group = {
    hooks: [{
      type: "command",
      command: `node "${script}" ${name}`,
      timeout: 10,
    }],
  };
  if (matcher) group.matcher = "*";
  hooks[name] = [group];
}

console.log(JSON.stringify({ hooks }, null, 2));
