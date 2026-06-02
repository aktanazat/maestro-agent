# maestro — live agent demo (the hero clip). Records the agent autonomously fixing a repo.
# Run: vhs demo/agent-demo.tape

Output demo/agent-demo.mp4
Output demo/agent-demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 1000
Set Theme "Catppuccin Mocha"
Set Padding 30
Set Margin 22
Set BorderRadius 12
Set TypingSpeed 30ms

Hide
Type "cd ~/Documents/projects/personal/maestro"
Enter
Type "clear"
Enter
# Start the agent and absorb the tsx warm-up while hidden, so the recording opens directly on
# the agent's first output instead of a blank prompt.
Type "npx tsx demo/agent-run.ts"
Enter
Sleep 2.4s
Show
Sleep 13s
