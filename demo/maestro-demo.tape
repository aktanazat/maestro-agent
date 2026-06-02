# maestro demo — scripted terminal cast (VHS). Renders demo/maestro-demo.mp4 + .gif
# Run: vhs demo/maestro-demo.tape

Output demo/maestro-demo.mp4
Output demo/maestro-demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1500
Set Height 900
Set Theme "Catppuccin Mocha"
Set Padding 32
Set Margin 24
Set BorderRadius 12
Set TypingSpeed 22ms

Hide
Type "cd ~/Documents/projects/personal/maestro"
Enter
Type "export BAT_THEME='Catppuccin Mocha' PS1='\033[2m$\033[0m '"
Enter
Type "clear"
Enter
Show
Sleep 500ms

# ---- Title ----
Type "cat demo/title.txt"
Enter
Sleep 3.5s
Type "clear"
Enter

# ---- 1. The registry ----
Type "# the registry: 60 tools, 8 namespaces. the model selects. one dispatch path."
Enter
Sleep 400ms
Type "node dist/index.js tools | sed -n '1,14p'"
Enter
Sleep 4.5s
Type "clear"
Enter

# ---- 2. Composable tool I/O ----
Type "# composable tools: one tool consumes another structured output"
Enter
Sleep 400ms
Type "sed -n '27,31p' README.md"
Enter
Sleep 4s
Type "clear"
Enter

# ---- 3. The eval works ----
Type "# eval: the full agent fixes seeded bugs in real temp git repos"
Enter
Sleep 400ms
Type "node dist/eval/cli.js 2>&1 | grep -E 'buggy-stats|broken-imports|pagination|tasks passed' | sed 's/^/  /'"
Enter
Sleep 5s
Type "clear"
Enter

# ---- 4. Long-horizon + subagent + compaction ----
Type "# a 27-call session: plans, delegates to a subagent, survives compaction"
Enter
Sleep 400ms
Type "node dist/eval/cli.js 2>&1 | grep -E 'fix-and-verify|forced-compaction|toolCalls=27' | sed 's/^/  /'"
Enter
Sleep 5s
Type "clear"
Enter

# ---- 5. CODE: the subagent ----
Type "# the subagent: the SAME loop, a scoped registry, a schema-validated return"
Enter
Sleep 400ms
Type "bat --color=always --style=numbers --line-range=83:111 src/subagent/spawn.ts"
Enter
Sleep 8.5s
Type "clear"
Enter

# ---- 6. CODE: one dispatch path ----
Type "# no switch over 60 tools: validate, permission-gate, dispatch, validate"
Enter
Sleep 400ms
Type "bat --color=always --style=numbers --line-range=137:172 src/tools/registry.ts"
Enter
Sleep 8.5s
Type "clear"
Enter

# ---- 7. CODE: durable memory across compaction ----
Type "# long-horizon: the plan ledger outlives context compaction"
Enter
Sleep 400ms
Type "bat --color=always --style=numbers --line-range=105:135 src/agent/context.ts"
Enter
Sleep 8.5s
Type "clear"
Enter

# ---- 8. The divergence moment ----
Type "# where the model and I diverged: the mock said OK, the live API said 400"
Enter
Sleep 400ms
Type "git log --oneline | grep -iE 'live Anthropic|codex code-grill' | sed 's/^/  /'"
Enter
Sleep 5.5s
Type "clear"
Enter

# ---- 9. Tested ----
Type "# 51 unit + integration tests. typecheck. lint. all green."
Enter
Sleep 400ms
Type "npm test --silent 2>&1 | tail -n 4 | sed 's/^/  /'"
Enter
Sleep 5s
Type "clear"
Enter

# ---- Closing ----
Type "cat demo/outro.txt"
Enter
Sleep 5s
