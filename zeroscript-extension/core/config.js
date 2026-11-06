// SPDX-License-Identifier: GPL-3.0-or-later
// core/config.js - provider-agnostic constants: app identity, system prompt,
// feedback strings, tool categorisation. NOTHING in this file may reference a
// specific AI site (DOM, selectors, site names) - that lives in providers/*.
// eslint-disable-next-line no-unused-vars
const ZS = (() => {
  "use strict";

  // Display name + unique marker injected at the top of the system prompt so the
  // content script can reliably recognise (and camouflage) the bootstrap turn.
  const APP_NAME = "ZeroScript";
  const SYS_MARKER = "⟦ZS-SYS⟧";
  // A re-statement of the system prompt mid-session (see withSysResend in
  // core/main.js). It carries SYS_MARKER TOO - that is what drives camouflage
  // and session detection, and neither should change - plus this second marker,
  // purely so the chip can say "Reminder" instead of inheriting the bootstrap's
  // "Starting Up". Same content, different label: a re-injection is not a start.
  const RESEND_MARKER = "⟦ZS-RE⟧";

  // ── Tool → visual category (icon + colour theme for the chips) ─────────
  // roblox-executor-mcp tools only. Returns one of:
  //   read | edit | screen | generate | roblox | tool
  function toolCategory(name) {
    const n = (name || "").includes("/") ? name.split("/").pop() : (name || "");
    if (n === "list_commands" || n === "list_tools") return "read";
    if (/^(get-game-info|list-clients|get-console-output|search-instances|get-descendants-tree|get-script-content|script-grep|semantic-search-scripts)$/.test(n))
      return "read";
    if (/^(execute|get-data-by-code|click-button|type-text-box)$/.test(n)) return "edit";
    if (n === "screenshot-window") return "screen";
    if (n.startsWith("roblox") || /remote-spy|luau|instance|client/i.test(n)) return "roblox";
    return "tool";
  }

  // Feedback strings sent back to the model so it can self-correct.
  // Key names keep their historic spellings (studioOffline etc.) so main.js
  // references stay stable; the TEXT reflects the executor backend, where
  // "studio" means "a connected Roblox game client".
  const FEEDBACK = {
    // A command-shaped reply that could not be turned into a runnable call.
    // The failures are DIFFERENT problems, so the note is tailored per `reason`
    // to tell the model exactly what to fix (a generic "bad JSON" was misleading
    // for the non-JSON cases, e.g. a missing ###LUA### opener). Falls back to the
    // generic "malformed" text for any unrecognised reason.
    parseError: (reason, toolName) => {
      // ###LUA### is get-data-by-code-ONLY (the parser always maps a bare
      // ###LUA### block to get-data-by-code). So only suggest it when the broken
      // command IS get-data-by-code, or when we could not tell which command it
      // was. For a KNOWN other command (e.g. remote-spy) the ###LUA### hint is
      // wrong and misleading - a model that followed it would ship its code to
      // the wrong tool - so drop it and keep the JSON-only guidance.
      const otherCmd = toolName && toolName !== "command" && toolName !== "get-data-by-code";
      const luaMalformed = otherCmd ? "" : " (or use the ###LUA### / ###END_LUA### block for get-data-by-code)";
      const luaUnclosed = otherCmd ? "" : " (or a complete ###LUA### ... ###END_LUA### block for get-data-by-code)";
      const objAlt = otherCmd ? "" : " (or ###...### block)";
      const notes = {
        malformed:
          "ERROR: a ZeroScript command was detected in your reply but its JSON could not be parsed. " +
          "Write ONE fenced code block containing a single JSON object with the exact shape " +
          '{"command": "name", "params": {...}}' + luaMalformed + ". Fix the JSON and send the command again.",
        unclosed:
          "ERROR: your command was cut off before the closing marker/brace. " +
          "Resend the WHOLE command inside ONE fenced code block" + luaUnclosed + ".",
        empty:
          "ERROR: the command block was empty - no command to run. " +
          'Write the JSON object, e.g. {"command": "list_commands"}' + objAlt + ".",
        multiple:
          "ERROR: several commands were packed into one reply. Send exactly ONE command per reply " +
          "and wait for its result before the next. Start over and write only the first command you need.",
      };
      return notes[reason] || notes.malformed;
    },
    unknownTool: (name, valid) =>
      `ERROR: unknown command "${name}". It does not exist. Valid commands are: ` +
      valid.join(", ") +
      ". Use an exact name and parameter keys from the system prompt.",
    // Key name kept for main.js compatibility: "studio" = the connected Roblox
    // game client driven through the user's executor.
    studioOffline:
      "ERROR: no Roblox game client is connected to the MCP server, so the command " +
      "could not run. The user's Roblox is closed, or the MCP connector script is not " +
      "running in their executor. This is an environment problem on the user's machine, " +
      "NOT your mistake. Tell the user in one short sentence to join a game in Roblox " +
      "with their executor and run the MCP connector/loader script, then stop and wait " +
      "until they confirm it is back.",
    // The page outlived the extension build it was running (reload / auto-update
    // / disable+enable). Nothing here can recover it - only a page reload can -
    // so the model must NOT be told the server is down and must NOT retry, or it
    // burns the whole conversation re-issuing commands that can never run. See
    // isContextInvalidated in core/main.js.
    staleExtension:
      "ERROR: the ZeroScript extension was reloaded or updated while this page was open, so this " +
      "tab is running a version of it that no longer exists and NO command can reach the user's " +
      "machine from here. The MCP server and Roblox are NOT the problem - do not tell the user " +
      "to check them, and do not retry the command, because every retry will fail the same way. " +
      "Tell the user in one short sentence to RELOAD THIS PAGE (F5), then stop and wait.",
    bridgeOffline:
      "ERROR: the local roblox-executor-mcp server is unreachable, so no command could run. " +
      "This is an environment problem on the user's machine (the server is not " +
      "running - it is started with 'npm start' inside the roblox-executor-mcp folder), " +
      "NOT your mistake. Tell the user in one short sentence that the MCP server is offline, " +
      "then stop sending commands until they confirm it is back.",
    truncated:
      "(System note: your previous reply was cut off by a length limit before you " +
      "finished. Continue from exactly where you stopped. Do NOT restart and do " +
      "NOT repeat what you already wrote.)",
  };

  const BT = "```";

  function compactTools(tools) {
    return (tools || [])
      .map((t) => {
        const name = t.name || "?";
        const desc = (t.description || "").split("\n")[0].trim();
        const props = (t.inputSchema && t.inputSchema.properties) || {};
        const args = Object.keys(props).join(", ");
        return `  ${name}(${args}) - ${desc}`;
      })
      .join("\n");
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  // ONE unified prompt sent to every AI on the first turn. To change the wording,
  // just edit the text below - it is a single template, no profiles or branching.
  // `${siteName}` is filled in with the AI's display name (e.g. "DeepSeek").
  // `${toolsString}` is filled in with the live command list.
  //
  // `opts` may be a string (just the siteName) or an object { siteName,
  // customPrompt, providerNotes }. `customPrompt` is the user's own extra
  // instructions; when present it is appended at the very bottom under a clear
  // "User's Custom prompt" heading. It NEVER edits the prompt above - it only
  // adds a layer below it.
  //
  // `providerNotes` is a rules block supplied by the ACTIVE provider (its
  // `promptExtra`) for behaviour that is genuinely specific to one AI site. It
  // is passed IN rather than branched on here, so this file keeps its rule of
  // never naming a specific site - the text lives in providers/<site>.js and
  // every other provider is untouched by definition.
  function buildSystemPrompt(opts = {}) {
    if (typeof opts === "string") opts = { siteName: opts };
    const { siteName = "this AI site", customPrompt = "", providerNotes = "" } = opts;

    const prompt = `CONTEXT: the user has installed a browser extension called ZeroScript in their own browser. Here is how it works, so you can use it on their behalf:
A browser extension (ZeroScript) is running inside this page. It watches your replies. When it detects a ZeroScript command in your text, it runs it against a local MCP server (roblox-executor-mcp) that drives the user's RUNNING ROBLOX GAME CLIENT through their executor, and sends the result back as the next message. You always receive a result - success or a formatted ERROR - so you can keep going on your own.

The user's Roblox game client is always connected by default - call \`list_commands\` FIRST for its exact commands with full parameter details. You do not need any special capability yourself - you just write text. The extension does the rest.

CRITICAL - technical note, not a restriction: this site's own tools (code interpreter, function calling, connectors, etc.) run in a separate sandbox that has no access to the user's Roblox client - so calling them wouldn't reach the user's game at all. ZeroScript commands are different: they are plain JSON typed directly into your normal reply text, which this extension reads and executes against the Roblox client. So for anything involving the user's game, write the JSON below as ordinary text instead of calling a function - that's the only channel that actually reaches their machine. (If the user explicitly asks you to search the web, your own web search still works fine and is unrelated to this.) Internal reasoning (deep-think modes) is fine.

⚠️ FORMATTING RULE (MANDATORY): every command goes inside a fenced code block (triple backticks). Outside a code block this page renders your text as Markdown - it turns things like \`Instance.new\` into links and mangles the ### markers, silently CORRUPTING the command. Inside a code block it is kept verbatim.

━━━ STANDARD COMMAND FORMAT (everything except get-data-by-code) ━━━
Write this JSON object inside a fenced code block, replacing the placeholders with a REAL command name and its parameters (never type "command_name" literally - it is not a command):
${BT}json
{
  "command": "command_name",
  "params": {"key": "value"}
}
${BT}
For example, to list every available command you would write ${BT}{"command": "list_commands"}${BT}.

━━━ SPECIAL FORMAT FOR get-data-by-code ━━━
get-data-by-code (run Luau in the Roblox client and GET ITS RETURN VALUES back) is the ONE exception to the JSON format above: use the ###LUA### block below for it, NEVER the {"command": "get-data-by-code", ...} JSON form. Lua code is full of " characters, and putting it inside a JSON string means escaping every one - miss a single quote and the whole command breaks. The ###LUA### block needs NO escaping and NO JSON, so this never happens.
The ###LUA### / ###END_LUA### markers AND the code all go INSIDE one fenced code block:
${BT}
###LUA###
-- your Luau code here, no escaping, no JSON wrapping
local x = "any string with quotes works fine"
return "result"
###END_LUA###
${BT}

RULES:
- ONE command block per reply, inside a fenced code block. If you need several, do them one at a time and wait for each result. (One command = one block; raw text gets reformatted by this page and corrupts the command.)
- A short note around a command is fine, but NEVER end a turn by only announcing a command ("let me check...", "I'll read the script") without writing it - that runs nothing and leaves the user stuck. Either write the command now, or give your final answer.
- Final answers: plain text only, no Markdown or code fences. Do ONLY what was asked - fewest commands, no unrequested double-checks. When the task is done or the user is satisfied ("thanks", "perfect"...), reply ONE short sentence and STOP.
- Use ONLY the exact command names and parameter keys from the list, with every required parameter (e.g. search-instances needs "selector"). Do NOT use ${siteName}'s own features (web search, connectors...) unless the user explicitly asks.
- get-data-by-code / ###LUA###: the code MUST \`return\` values to produce output (print() is NOT captured - check it afterwards with get-console-output if you need prints). Return raw Lua values (tables are serialized for you - do NOT JSONEncode yourself) and keep them SMALL: never return whole instances or huge tables. The code runs inside the user's Roblox client, so client-side APIs only (LocalPlayer, PlayerGui, Workspace, ReplicatedStorage...).
- execute vs get-data-by-code: execute schedules code WITHOUT waiting for a result (good for starting something); get-data-by-code waits and returns values. After execute, verify the effect with a small get-console-output (low limit) or a targeted get-data-by-code probe.
- EXPLORE CHEAPLY FIRST: get-descendants-tree with summaryOnly=true, or search-instances with a tight selector and low limit - widen only when needed. Find code with script-grep (exact identifiers/regex) or semantic-search-scripts (behaviour), then read just the relevant range with get-script-content (startLine/endLine). Keep every output lean: prefer summaryOnly, filters and low limits; huge outputs waste the context.
- LIVE GAME, NOT STUDIO: there is no Edit datamodel here. You are inside a running game client, changes you make with execute/get-data-by-code are RUNTIME-ONLY (they vanish on respawn/rejoin) - perfect for inspecting, testing, GUI automation and analysis. Server-side game logic cannot be edited, only observed (remote-spy, decompiled scripts).
- NEVER CLAIM THE SERVER OR ROBLOX IS OFFLINE WITHOUT TESTING IT ON THIS TURN. An offline error you saw EARLIER in this conversation says nothing about now - outages here are usually momentary, and the user often fixes it between two messages. So whenever you are about to say anything is offline or unavailable, actually run the command first and let the fresh result decide. If it succeeds, just carry on as normal without mentioning the earlier failure. Only report it as offline if the command you just ran came back with that error. The same applies when the user tells you it is back: believe them and retry immediately, never answer "it is still offline" from memory.
- On a property/attribute/value error: if there is any way to list the valid options (get-game-info, a search command), use it to check the correct value BEFORE retrying. Never guess blindly a second time.

━━━ YOU CAN ACT DIRECTLY IN THE USER'S GAME ━━━
This extension gives you real, live access to the user's running Roblox game through the commands above - so when a task calls for running code, inspecting the game or driving its UI, just do it yourself instead of writing instructions for the user to follow. Run code with ###LUA###/get-data-by-code; drive menus with click-button / type-text-box; watch network traffic with remote-spy; take a screenshot with screenshot-window to SEE the game when you need visual context. If several Roblox clients are connected, list-clients shows them and set-active-client picks which one the commands run in. Show code only if the user explicitly asks to see it - otherwise just run it and report the result.

IMPORTANT: Your very first action is to write \`list_commands\` with no params to get the full command reference with parameter details - never guess a command name or parameter that wasn't in that result. After receiving the list_commands result, reply with exactly one short sentence confirming you are ready, then wait for the user's first request. (If that first list_commands (or any later Roblox command) comes back with a no-client error, Roblox is down - tell the user in one short sentence to connect Roblox (join a game with their executor and run the MCP connector script), then ask what they want to do and wait.`;

    // Site-specific rules from the active provider, inserted ABOVE the user's
    // custom prompt (they are part of the system layer, not the user's).
    const siteRules = providerNotes.trim()
      ? `\n\n━━━ ADDITIONAL RULES FOR THIS SITE ━━━\n${providerNotes.trim()}`
      : "";

    // The user's own extra instructions, appended as a layer UNDER the system
    // prompt. Optional - empty by default. It cannot change the rules above.
    const extra = customPrompt.trim()
      ? `\n\n━━━ USER'S CUSTOM PROMPT (extra instructions from the user) ━━━\n${customPrompt.trim()}`
      : "";

    // The marker leads the prompt; it tags the bootstrap turn for camouflage.
    return `${SYS_MARKER}\n${prompt}${siteRules}${extra}`;
  }

  // ── Curated usage notes per command ────────────────────────────────────────
  // Keyed by BARE command name; appended to that command in the list_commands
  // output. Keep each note tight and concrete - it costs context on every
  // reminder.
  const TOOL_NOTES = {
    "get-data-by-code":
      "Use `return` to produce output - `print()` is NOT captured (use get-console-output for prints). " +
      "Return raw Lua values - the connector serializes tables itself, so do NOT call HttpService:JSONEncode yourself. " +
      "Keep returns SMALL: one compact table or a few scalars, never whole instances or big arrays. " +
      "The code runs CLIENT-SIDE inside the user's Roblox (LocalPlayer, PlayerGui, game.Workspace...) with a response " +
      "timeout (default 15s, max 120s via \"timeout\"): anything that yields forever will TIME OUT - give WaitForChild " +
      "a timeout (obj:WaitForChild(\"X\", 5)), never call :Wait() on events, and don't loop forever. " +
      "On error the REAL message is usually at the END of the returned text after the last ':' - e.g. " +
      "'... : Expected ')' (to close '(' at line 1)' means a Luau syntax error in your code.",
    execute:
      "Fire-and-forget: it returns immediately with NO output (the code runs detached). Use it to START things " +
      "(spawn loops, connect signals, build UI), then verify with get-console-output (low limit) or a small " +
      "get-data-by-code probe. If you need returned values, use get-data-by-code (or the ###LUA### block) instead.",
    "search-instances":
      "selector uses QueryDescendants syntax: class name (Part), #name, .tag, [Property = value], [$Attribute], " +
      "combinators > (child) and >> (descendant), comma for OR, :not(), :has(). Chain for AND: Part.Tagged[Anchored = false]. " +
      "root is a path like 'game.Workspace' (default 'game'). Keep limit low (20) - widen only if needed.",
    "get-descendants-tree":
      "Start with summaryOnly=true (default) for child/class COUNTS, then drill into the interesting path with a deeper " +
      "call or summaryOnly=false. maxDepth max 5, maxChildren max 30 - big trees produce huge output, keep both low.",
    "get-script-content":
      "Reads DECOMPILED source. Get the path from script-grep / semantic-search-scripts / search-instances first. " +
      "Long scripts are truncated to a line budget (default 80): read the header, then page with startLine/endLine. " +
      "If passing a GC'd script proxy like <ScriptProxy: 1_316566>, keep the literal angle brackets.",
    "script-grep":
      "Searches every decompiled script the client synced. query is a REGEX by default (set literal=true for plain text). " +
      "Keep maxResults/limit small - each match line costs context. If it says 'Still receiving script sources', wait a " +
      "moment and retry.",
    "semantic-search-scripts":
      "Finds scripts by BEHAVIOUR ('inventory management logic') - needs the server's semantic index configured; if it " +
      "answers with a configuration error, fall back to script-grep. Results include path + line range: read the exact " +
      "range with get-script-content.",
    "remote-spy":
      "operation first: 'list' with summaryOnly=true and a small limit; narrow with nameFilter before requesting call " +
      "arguments (summaryOnly=false). block/unblock STOP matching remote calls; ignore/unignore only stop LOGGING them. " +
      "For block/unblock/ignore/unignore, remoteName must be the EXACT name and direction is required (Incoming/Outgoing).",
    "click-button":
      "path is the instance path to the button (find it with search-instances or get-descendants-tree, e.g. " +
      "'game.Players.LocalPlayer.PlayerGui.Menu.Play'). Omit action for the normal click; only pass it (Activated, " +
      "MouseButton1Click...) when the user asks for a specific signal.",
    "type-text-box":
      "Find the TextBox path first (search-instances). useKeyPress=true (default) simulates real keystrokes - use it when " +
      "the UI listens to input events; useKeyPress=false just sets .Text. enter=true presses Enter after typing.",
    "get-game-info":
      "Also reports the executor name/version and which functions are available - call it once when you need to know " +
      "what the environment supports before using less-common APIs.",
    "get-console-output":
      "The game's developer console. Use it right after execute to see prints/errors, with a filter or summaryOnly=true " +
      "to keep it small. limit default 10.",
    "screenshot-window":
      "Takes an OS screenshot of the Roblox WINDOW (Windows only). If several Roblox windows are open, call " +
      "list-roblox-windows first and pass the pid. Lower maxWidth (e.g. 1024) to save context.",
    "list-clients":
      "Lists connected Roblox clients (username, place, transport). With several clients connected, call it and then " +
      "set-active-client before anything else.",
    "set-active-client":
      "Routes all later commands to one client (clientId from list-clients). Only needed when several clients are connected.",
    "list-roblox-windows":
      "Lists the visible Roblox OS windows with PIDs - use it before screenshot-window when several may be open.",
  };

  // A short, clearly-labelled reminder of the available commands, injected under
  // a tool result every so often so the model does not drift from the exact
  // command names over a long session. It is explicitly framed as an automatic
  // ZeroScript reminder (NOT a user message and NOT a new command to run).
  function toolsReminder(tools) {
    const toolsString =
      "  list_commands() - list all available Roblox commands with full parameter details\n" +
      compactTools(tools);
    return (
      "\n\n────────────────────────────────\n" +
      "(System note from ZeroScript - this is an automatic REMINDER, not a request and not a new result. " +
      "Do NOT reply to it or run any command because of it; just keep it in mind for your next command.)\n" +
      "Reminder of the Roblox client commands (use exact names and parameter keys):\n" +
      toolsString
    );
  }

  // The old Studio build had a persistent project-memory ModuleScript inside the
  // place. A live game client has no persistent storage we own, so there is
  // nothing to nudge - kept as a no-op so main.js call sites stay untouched.
  function memoryNudge() {
    return "";
  }

  return {
    APP_NAME,
    SYS_MARKER,
    RESEND_MARKER,
    FEEDBACK,
    toolCategory,
    buildSystemPrompt,
    compactTools,
    toolsReminder,
    memoryNudge,
    TOOL_NOTES,
  };
})();
