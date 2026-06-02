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
Show
Sleep 400ms

Type "npx tsx demo/agent-run.ts"
Enter
Sleep 15s
