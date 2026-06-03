# Records a clean playback of a REAL live-model run (Gemini 2.5 Flash) fixing a bug to green,
# reconstructed from its mission log (demo/live-solve/mission.jsonl). Run: vhs demo/live-solve.tape

Output demo/live-solve.mp4
Output demo/live-solve.gif

Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 900
Set Theme "Catppuccin Mocha"
Set Padding 30
Set Margin 20
Set BorderRadius 12

Hide
Type "cd ~/Documents/projects/personal/maestro"
Enter
Type "clear"
Enter
Type "npx tsx demo/live-replay.ts"
Enter
Sleep 2.4s
Show
Sleep 14s
